-- ===========================================================================
-- Patch 2026-08-12 — C4, C1, S9 from docs/REMEDIATION.md
--
-- schema.sql is the canonical definition, but running it DROPS every table.
-- This is the same change expressed as alters, safe to run against a live
-- database with real trips in it. Run it once, top to bottom, in the
-- Supabase SQL editor. Every statement is idempotent.
--
--   C4  Boarding a student recorded as absent / parent pickup / no-show.
--   C1  Departing a stop with somebody still unaccounted for.
--   S9  Integrity constraints on trip_stop_progress.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- S9 + C1: new columns and constraints on trip_stop_progress
-- ---------------------------------------------------------------------------

alter table trip_stop_progress
  add column if not exists departed_with_unresolved boolean not null default false,
  add column if not exists skipped boolean not null default false;

-- Pre-flight. If either returns rows, fix them before the constraints below,
-- or the ALTER fails and tells you the constraint name and nothing else.
select id, trip_id, stop_id, arrived_at, departed_at from trip_stop_progress
where arrived_at is not null and departed_at is not null and departed_at < arrived_at;

alter table trip_stop_progress drop constraint if exists stop_progress_ordering;
alter table trip_stop_progress add constraint stop_progress_ordering
  check (departed_at is null or arrived_at is null or departed_at >= arrived_at);

alter table trip_stop_progress drop constraint if exists stop_progress_skipped_not_served;
alter table trip_stop_progress add constraint stop_progress_skipped_not_served
  check (not skipped or arrived_at is null);

-- ---------------------------------------------------------------------------
-- C1: who is unaccounted for at a stop, and the guard that uses it
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------

-- Who is unaccounted for at one stop. One definition, used by the guard, by the
-- incident recorder, and mirrored in the driver's app (see unresolvedAtStop in
-- src/lib/types.ts) so the pre-flight warning names exactly who the database
-- would refuse on.
--
-- A rider sits at two stops -- where they get on and where they get off -- so
-- which statuses count as unresolved depends on which of the two this is:
--   * boarding here: still `scheduled` (never seen) or `waiting` (they told us
--     they were at the hub and we drove off without them -- the worse case,
--     because the app KNEW they were there);
--   * getting off here: still `boarded` or `in_transit`, i.e. on the van as it
--     leaves the place they were supposed to get out.
-- `unable_to_drop_off` is deliberately not unresolved: that one is already
-- raised, already blocks trip completion, and the driver is meant to drive on.
create or replace function riders_unresolved_at_stop(target_trip uuid, target_stop uuid)
returns setof student_trip_status
language sql stable security definer set search_path = public as $$
  select sts.* from student_trip_status sts
  where sts.trip_id = target_trip
    and (
      (sts.pickup_stop_id  = target_stop and sts.status in ('scheduled', 'waiting'))
      or
      (sts.dropoff_stop_id = target_stop and sts.status in ('boarded', 'in_transit'))
    );
$$;

-- Security definer, so it reads past RLS -- which is right for a trigger and
-- wrong for a client. Postgres grants EXECUTE to public by default, and every
-- function in this schema is reachable over PostgREST as /rpc/<name>, so without
-- this any signed-in account could ask it about any trip and any stop and read
-- back rider rows it cannot select. The triggers below are unaffected: they run
-- inside security-definer functions owned by the same role.
revoke execute on function riders_unresolved_at_stop(uuid, uuid) from public, anon, authenticated;

create or replace function guard_stop_departure() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  unresolved int;
begin
  -- An arrival is recorded ONCE. A second tap is a mistap, not a correction, and
  -- it must not quietly move the timestamp the parents were already shown. Staff
  -- can still fix it -- that is what the exception queue is for -- but the
  -- driver's app cannot overwrite its own history.
  if tg_op = 'UPDATE' and not is_staff() then
    if old.arrived_at is not null then
      new.arrived_at := old.arrived_at;
    end if;
    if old.departed_at is not null then
      new.departed_at := old.departed_at;
    end if;
  end if;

  -- Caught here as well as by the check constraint, so the driver gets a
  -- sentence instead of a constraint name. The realistic cause is a device clock
  -- that has jumped, since both timestamps come from the phone.
  if new.arrived_at is not null and new.departed_at is not null
     and new.departed_at < new.arrived_at then
    raise exception
      'Departure (%) is before arrival (%) at this stop. Check the device clock.',
      to_char(new.departed_at, 'HH24:MI:SS'), to_char(new.arrived_at, 'HH24:MI:SS');
  end if;

  -- Only the moment a departure is FIRST recorded is guarded. Later edits to the
  -- row (a staff correction, a skip flag) do not re-ask the question.
  if new.departed_at is null then return new; end if;
  if tg_op = 'UPDATE' and old.departed_at is not null then return new; end if;

  select count(*) into unresolved
  from riders_unresolved_at_stop(new.trip_id, new.stop_id);

  if unresolved > 0 and not new.departed_with_unresolved then
    raise exception
      'Cannot leave this stop: % student(s) here still have no outcome.', unresolved;
  end if;

  return new;
end;
$$;

drop trigger if exists on_stop_departure on trip_stop_progress;
create trigger on_stop_departure before insert or update on trip_stop_progress
  for each row execute function guard_stop_departure();

-- The cost of leaving anyway. One incident PER CHILD, because each one is
-- separately unaccounted for and each one gets resolved separately in the
-- exception queue. Setting student_id is what keeps the description off the
-- route-wide broadcast (see notify_on_incident) -- the other families do not get
-- told this child's name, but the office and that child's own guardians do,
-- immediately.
create or replace function record_forced_departure() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  stop_name text;
  actor_name text;
  driver uuid;
  rider record;
begin
  if new.departed_at is null or not new.departed_with_unresolved then
    return new;
  end if;
  -- Already filed on an earlier write of this row.
  if tg_op = 'UPDATE' and old.departed_at is not null and old.departed_with_unresolved then
    return new;
  end if;

  select coalesce(h.name, s.name, 'a stop') into stop_name
  from route_stops rs
  left join hubs h    on h.id = rs.hub_id
  left join schools s on s.id = rs.school_id
  where rs.id = new.stop_id;

  select t.driver_id into driver from daily_trips t where t.id = new.trip_id;

  -- Two steps on purpose. `select coalesce(...) into` does nothing when the
  -- select matches NO row, so the variable stays null and every || below it
  -- yields null -- an incident with no description at all. The caller is not
  -- always a profile: a service-role write, or a cron job, has no auth.uid().
  select p.full_name into actor_name from profiles p where p.id = auth.uid();
  actor_name := coalesce(nullif(btrim(actor_name), ''), 'The driver');

  for rider in
    select u.student_id,
           u.status,
           u.pickup_stop_id,
           coalesce(nullif(p.full_name, ''), 'A student') as name
    from riders_unresolved_at_stop(new.trip_id, new.stop_id) u
    join profiles p on p.id = u.student_id
  loop
    insert into incidents (trip_id, student_id, driver_id, kind, severity, description)
    values (
      new.trip_id, rider.student_id, driver, 'other', 'high',
      actor_name || ' left ' || stop_name || ' at '
        || to_char(new.departed_at, 'HH12:MI AM') || ' and '
        || rider.name
        || case when rider.pickup_stop_id = new.stop_id
                then ' did not board (still recorded as '
                else ' did not get off (still recorded as ' end
        || replace(rider.status::text, '_', ' ')
        || '). Nobody has confirmed where they are.'
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists on_forced_departure on trip_stop_progress;
create trigger on_forced_departure after insert or update on trip_stop_progress
  for each row execute function record_forced_departure();

-- ---------------------------------------------------------------------------
-- C4: a note is required to board a student recorded as away
-- ---------------------------------------------------------------------------

-- exception with no explanation is just a contradiction in the data. The note is
-- required HERE and not only in the driver's app, because "the UI collects it"
-- is exactly the guarantee that a direct API call ignores -- and this is the one
-- write where the record and the child disagree about where the child is.
--
-- The note lands in audit_logs.reason via log_rider_status(), and in the
-- notification body via notify_on_rider_status(). Staff overrides already carry
-- one ("Override by <name>: <reason>"), so this costs them nothing.
create or replace function guard_boarding_after_away() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'boarded'
     and old.status in ('absent', 'parent_pickup', 'no_show')
     and coalesce(btrim(new.note), '') = '' then
    raise exception
      'Boarding a student recorded as % needs a note saying what happened.',
      replace(old.status::text, '_', ' ');
  end if;
  return new;
end;
$$;

drop trigger if exists on_boarding_after_away on student_trip_status;
create trigger on_boarding_after_away before update on student_trip_status
  for each row execute function guard_boarding_after_away();

-- ---------------------------------------------------------------------------
-- C4: the away -> boarded notification, and the per-student incident routing
-- that keeps one child's name off a route-wide broadcast
-- ---------------------------------------------------------------------------

create or replace function notify_on_rider_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  student_name text;
  when_txt text := to_char(now(), 'HH12:MI AM');
  title text;
  body text;
  kind_txt text := new.status::text;
  audience uuid[];
begin
  if new.status = old.status then
    return new;
  end if;

  select full_name into student_name from profiles where id = new.student_id;
  student_name := coalesce(nullif(student_name, ''), 'The student');

  -- Who hears about it, per the blueprint's notification matrix.
  case new.status
    when 'waiting' then
      -- Student checked in -> driver and coordinator.
      title := student_name || ' is waiting at the hub';
      body  := 'Checked in at ' || when_txt || '.';
      select array_agg(id) into audience from (
        select p.id from profiles p
        where (p.role in ('coordinator', 'admin') and p.status = 'active')
        union
        select t.driver_id from daily_trips t where t.id = new.trip_id and t.driver_id is not null
      ) x;

    when 'boarded' then
      if old.status in ('absent', 'parent_pickup', 'no_show') then
        -- A child the record said was NOT travelling is now on the van. This is
        -- the state the whole app exists to prevent, and the fix is to make it
        -- recordable rather than to leave the driver with no buttons and the
        -- child in the vehicle anyway. So it is not filed as a routine boarding:
        -- the coordinator hears about it, because they are holding the absence
        -- request this just contradicted, and the guardians are told in words
        -- that say what changed.
        title := student_name || ' boarded after being recorded as '
                 || replace(old.status::text, '_', ' ');
        body  := coalesce(nullif(btrim(new.note), ''), 'No reason was given.')
                 || ' Boarded at ' || when_txt || '.';
        kind_txt := 'boarded_after_away';
        select array_agg(id) into audience from (
          select parent_id as id from guardian_links
          where student_id = new.student_id and status = 'accepted'
          union
          select p.id from profiles p
          where p.role in ('coordinator', 'admin') and p.status = 'active'
        ) x;
      else
        title := student_name || ' boarded the vehicle';
        body  := 'Confirmed by the driver at ' || when_txt || '.';
        select array_agg(parent_id) into audience from guardian_links
        where student_id = new.student_id and status = 'accepted';
      end if;

    when 'dropped_off' then
      title := student_name || ' was dropped off safely';
      body  := 'Confirmed by the driver at ' || when_txt || '.';
      select array_agg(parent_id) into audience from guardian_links
      where student_id = new.student_id and status = 'accepted';

    when 'no_show' then
      title := student_name || ' did not appear at the hub';
      body  := 'The driver recorded a no-show at ' || when_txt || '.';
      select array_agg(id) into audience from (
        select parent_id as id from guardian_links
        where student_id = new.student_id and status = 'accepted'
        union
        select p.id from profiles p
        where p.role in ('coordinator', 'admin') and p.status = 'active'
      ) x;

    when 'unable_to_drop_off' then
      -- Blueprint §6.3: student remains onboard; coordinator must act.
      title := 'URGENT — could not drop off ' || student_name;
      body  := coalesce(new.note, 'The driver could not complete the planned drop-off.')
               || ' The student is still on the vehicle.';
      select array_agg(id) into audience from (
        select parent_id as id from guardian_links
        where student_id = new.student_id and status = 'accepted'
        union
        select p.id from profiles p
        where p.role in ('coordinator', 'admin') and p.status = 'active'
      ) x;

    else
      return new;
  end case;

  if audience is not null then
    insert into notifications (user_id, title, body, kind)
    select distinct u, title, body, kind_txt
    from unnest(audience) as u
    where u is not null;
  end if;

  return new;
end;
$$;

drop trigger if exists on_rider_status_change on student_trip_status;
create trigger on_rider_status_change after update on student_trip_status
  for each row execute function notify_on_rider_status();

create or replace function notify_on_incident() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  route_name text;
  student_name text;
begin
  select rt.name into route_name
  from daily_trips t join route_templates rt on rt.id = t.route_id
  where t.id = new.trip_id;

  if new.student_id is not null then
    -- An incident about ONE child is not route-wide news, and its description
    -- names that child -- so broadcasting it would tell every other family on
    -- the van who was left behind, or who was in trouble. Only their own
    -- guardians hear it. Coordinators still get everything, below.
    select full_name into student_name from profiles where id = new.student_id;
    student_name := coalesce(nullif(btrim(student_name), ''), 'a student');

    insert into notifications (user_id, title, body, kind)
    select gl.parent_id,
           'Urgent — ' || student_name || ' on route ' || coalesce(route_name, ''),
           coalesce(new.description, 'The driver has reported an issue.'),
           new.kind::text
    from guardian_links gl
    where gl.student_id = new.student_id and gl.status = 'accepted';
  else
    insert into notifications (user_id, title, body, kind)
    select distinct gl.parent_id,
           case when new.kind = 'delay'
                then 'Route ' || coalesce(route_name, '') || ' is delayed'
                else 'Incident on route ' || coalesce(route_name, '') end,
           coalesce(new.description, 'The driver has reported an issue.'),
           new.kind::text
    from student_trip_status sts
    join guardian_links gl on gl.student_id = sts.student_id and gl.status = 'accepted'
    where sts.trip_id = new.trip_id
      and sts.status not in ('absent', 'parent_pickup', 'no_show');
  end if;

  insert into notifications (user_id, title, body, kind)
  select p.id,
         'Incident reported on ' || coalesce(route_name, 'a route'),
         coalesce(new.description, new.kind::text),
         new.kind::text
  from profiles p where p.role in ('coordinator', 'admin') and p.status = 'active';

  return new;
end;
$$;

drop trigger if exists on_incident_reported on incidents;
create trigger on_incident_reported after insert on incidents
  for each row execute function notify_on_incident();
