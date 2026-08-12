-- ===========================================================================
-- Patch 2026-08-12 (second) — everything remaining from docs/REMEDIATION.md
-- except C3, the offline queue.
--
-- schema.sql is the canonical definition but DROPS every table. This is the
-- same change expressed as alters, safe to run against a live database with
-- real trips in it. Run it once, top to bottom, in the Supabase SQL editor.
-- Every statement is idempotent, so a re-run is harmless.
--
-- Apply 2026-08-12-c4-c1-s9.sql FIRST if you have not already.
--
--   C2  The watchdog — the only thing that watches the clock.
--   C5  Undo, and a correction path for stop progress below admin.
--   C6  Arrival alerts move off the device and onto the notification path.
--   C7  Wrong-stop boarding and cross-van lookup in manual mode.
--   C8  A transition table: what may follow what.
--   S1  Structured delay. S2 no-show escalation. S4 cutoff at trip start.
--   S5  Roster removal. S6 push delivery record. S7 departure notification.
--   N1  Collapsed duplicate alerts. N2 check-in window. N5 targeted announcements.
--
-- N3 (the audit-log viewer) and N4 (cutoffs in Setup) are app-only — no SQL.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- New types
-- ---------------------------------------------------------------------------
do $do$
begin
  if not exists (select 1 from pg_type where typname = 'watchdog_kind') then
    create type watchdog_kind as enum (
      'trip_not_started', 'stop_not_reached', 'rider_waiting',
      'trip_overrunning', 'rider_still_onboard', 'urgent_unacknowledged'
    );
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- Settings: watchdog thresholds and the undo window (C2, C5)
-- ---------------------------------------------------------------------------
alter table organization
  add column if not exists watchdog_enabled          boolean not null default true,
  add column if not exists watchdog_trip_start_min   int not null default 10,
  add column if not exists watchdog_stop_arrival_min int not null default 15,
  add column if not exists watchdog_waiting_min      int not null default 20,
  add column if not exists watchdog_trip_max_min     int not null default 120,
  add column if not exists watchdog_onboard_min      int not null default 15,
  add column if not exists undo_window_sec           int not null default 90;

-- ---------------------------------------------------------------------------
-- S6: a delivery record on every notification, and acknowledgement on the
-- urgent ones. Before this, a user with no push token produced no row, no
-- retry and no trace.
-- ---------------------------------------------------------------------------
alter table notifications
  add column if not exists delivery_state  text not null default 'pending',
  add column if not exists delivery_detail text,
  add column if not exists delivered_at    timestamptz,
  add column if not exists requires_ack    boolean not null default false,
  add column if not exists acknowledged_at timestamptz,
  add column if not exists acknowledged_by uuid references profiles on delete set null;

alter table notifications drop constraint if exists notifications_delivery_state_check;
alter table notifications add constraint notifications_delivery_state_check
  check (delivery_state in ('pending', 'sent', 'no_token', 'failed'));

create index if not exists notifications_unacked_idx
  on notifications (requires_ack, acknowledged_at)
  where requires_ack and acknowledged_at is null;

-- ---------------------------------------------------------------------------
-- N5: announcements can name one child as well as one route.
-- ---------------------------------------------------------------------------
alter table announcements
  add column if not exists student_id uuid references profiles on delete cascade;

-- ---------------------------------------------------------------------------
-- C2: what the watchdog has noticed and nobody has said is fine yet.
-- ---------------------------------------------------------------------------
create table if not exists watchdog_alerts (
  id              uuid primary key default gen_random_uuid(),
  trip_id         uuid references daily_trips on delete cascade,
  stop_id         uuid references route_stops on delete set null,
  student_id      uuid references profiles on delete cascade,
  notification_id uuid references notifications on delete cascade,
  kind            watchdog_kind not null,
  detail          text not null,
  raised_at       timestamptz not null default now(),
  notified_at     timestamptz,
  resolved_at     timestamptz,
  resolved_by     uuid references profiles on delete set null,
  resolution      text
);

-- Expression index, not a unique constraint: NULLs are distinct in a unique
-- constraint, so `(trip, null, null, 'trip_not_started')` would insert on every
-- single five-minute pass.
create unique index if not exists watchdog_alerts_once on watchdog_alerts (
  kind,
  coalesce(trip_id,         '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(stop_id,         '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(student_id,      '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(notification_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
create index if not exists watchdog_alerts_open_idx
  on watchdog_alerts (resolved_at, raised_at desc);

alter table watchdog_alerts enable row level security;
drop policy if exists "staff manage watchdog alerts" on watchdog_alerts;
create policy "staff manage watchdog alerts" on watchdog_alerts for all
  using (is_staff()) with check (is_staff());

-- ---------------------------------------------------------------------------
-- C6: which "van is nearly here" alerts have already gone out.
-- ---------------------------------------------------------------------------
create table if not exists arrival_alerts (
  id      uuid primary key default gen_random_uuid(),
  trip_id uuid not null references daily_trips on delete cascade,
  stop_id uuid not null references route_stops on delete cascade,
  minutes int not null,
  sent_at timestamptz not null default now(),
  unique (trip_id, stop_id, minutes)
);

alter table arrival_alerts enable row level security;
drop policy if exists "staff read arrival alerts" on arrival_alerts;
create policy "staff read arrival alerts" on arrival_alerts for select using (is_staff());

-- ---------------------------------------------------------------------------
-- C5: staff could only READ stop progress, so a coordinator could not fix a
-- mistapped departure at all — the only tool was rerun_trip, which is
-- admin-only and wipes the whole trip.
-- ---------------------------------------------------------------------------
drop policy if exists "staff read stop progress" on trip_stop_progress;
drop policy if exists "staff manage stop progress" on trip_stop_progress;
create policy "staff manage stop progress" on trip_stop_progress for all
  using (is_staff()) with check (is_staff());

-- ---------------------------------------------------------------------------
-- Functions and triggers. All `create or replace`, so re-running is safe.
-- ---------------------------------------------------------------------------

create or replace function is_guardian_of_by(parent uuid, child uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from guardian_links
    where parent_id = parent and student_id = child and status = 'accepted'
  );
$$;

create or replace function within_checkin_window(target_trip uuid, target_stop uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from daily_trips t
    left join route_stops rs on rs.id = target_stop
    cross join organization o
    where t.id = target_trip
      and o.id = 1
      and t.date = current_date
      and (
        rs.planned_arrival is null
        or now() between (t.date + rs.planned_arrival)::timestamptz
                         - make_interval(mins => o.checkin_window_min)
                     and (t.date + rs.planned_arrival)::timestamptz + interval '30 min'
      )
  );
$$;

create or replace function undoing() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.undoing', true), '') = 'on';
$$;

create or replace function set_notification_ack() returns trigger
language plpgsql set search_path = public as $$
begin
  new.requires_ack := new.kind in ('unable_to_drop_off', 'no_show_after_checkin');
  return new;
end;
$$;
drop trigger if exists on_notification_created on notifications;
create trigger on_notification_created before insert on notifications
  for each row execute function set_notification_ack();

create or replace function ensure_daily_trips(target_date date default current_date)
returns int
language plpgsql security definer set search_path = public as $$
declare
  created int := 0;
  tpl record;
  -- Prefixed because an unprefixed `trip_id` would be ambiguous against the
  -- column of the same name inside the INSERT below.
  v_trip_id uuid;
begin
  for tpl in
    select * from route_templates
    where active
      and extract(isodow from target_date)::int = any (operating_weekdays)
  loop
    insert into daily_trips (route_id, date, driver_id, vehicle_id, status)
    values (tpl.id, target_date, tpl.default_driver_id, tpl.default_vehicle_id, 'scheduled')
    on conflict (route_id, date) do nothing
    returning id into v_trip_id;

    if v_trip_id is null then
      select id into v_trip_id from daily_trips
      where route_id = tpl.id and date = target_date;
    else
      created := created + 1;
    end if;

    insert into student_trip_status (trip_id, student_id, status, pickup_stop_id, dropoff_stop_id)
    select
      v_trip_id,
      ra.student_id,
      case
        when cr.kind = 'absent'        then 'absent'::rider_status
        when cr.kind = 'parent_pickup' then 'parent_pickup'::rider_status
        else 'scheduled'::rider_status
      end,
      ra.pickup_stop_id,
      ra.dropoff_stop_id
    from route_assignments ra
    -- A request covers `date`..`end_date`, so a holiday booked once keeps
    -- seating the student as Absent every day it spans. Null end_date is the
    -- ordinary single-day case.
    left join lateral (
      select kind from change_requests c
      where c.student_id = ra.student_id
        and target_date between c.date and coalesce(c.end_date, c.date)
        and c.approval in ('auto_approved', 'approved')
        and c.kind in ('absent', 'parent_pickup')
      order by c.created_at desc limit 1
    ) cr on true
    where ra.route_id = tpl.id
      -- Blueprint §3.2: "Only students attending the club are included."
      and (
        tpl.type <> 'club'
        or exists (
          select 1 from change_requests c
          where c.student_id = ra.student_id
            and target_date between c.date and coalesce(c.end_date, c.date)
            and c.kind = 'club_attending'
            and c.approval in ('auto_approved', 'approved')
        )
      )
    on conflict (trip_id, student_id) do nothing;

    -- S5: roster generation ADDED but never REMOVED. `on conflict do nothing`
    -- means a student taken off a route stayed on today's trip for ever — and
    -- because they can never be given an outcome, they block the driver from
    -- ending the trip at all. Mirrors the club-cancellation branch, which
    -- already does exactly this.
    --
    -- Only `scheduled` rows. Anything further along is a real record of a real
    -- child on a real van, and no amount of roster editing may delete that.
    delete from student_trip_status sts
    where sts.trip_id = v_trip_id
      and sts.status = 'scheduled'
      and not exists (
        select 1 from route_assignments ra
        where ra.route_id = tpl.id and ra.student_id = sts.student_id
      );
  end loop;

  return created;
end;
$$;
revoke execute on function ensure_daily_trips(date) from public, anon, authenticated;

create or replace function ensure_todays_trips() returns int
language plpgsql security definer set search_path = public as $$
begin
  if not is_active() then
    raise exception 'Your account is not active.';
  end if;
  return ensure_daily_trips(current_date);
end;
$$;
grant execute on function ensure_todays_trips() to authenticated;

create or replace function decide_change_request() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  org organization%rowtype;
  cutoff timestamptz;
  span text;
begin
  select * into org from organization where id = 1;

  -- The cutoff is judged against the FIRST day the request covers. A holiday
  -- booked in advance is always in time; only the day it starts on can be late.
  -- Morning cutoff governs absence; afternoon governs pickup and club changes.
  cutoff := (new.date + case
    when new.kind = 'absent' then org.morning_cutoff
    else org.afternoon_cutoff
  end)::timestamptz;

  -- S4: the cutoff is a WALL CLOCK, and the thing that actually matters is the
  -- trip boundary. Between 06:30 and the van pulling away, an absence sat
  -- `pending` -- so if nobody happened to be watching the queue, the driver
  -- waited at the hub for a child who was never coming, then filed a no-show
  -- that alarmed the parents and the office about a child sitting at home.
  --
  -- So: auto-approve any time before that student's trip has actually STARTED,
  -- and hard-freeze the moment it does. An unnecessary absence costs a stop. A
  -- missed one costs a false alarm and a phone call.
  if new.kind in ('absent', 'parent_pickup') then
    if exists (
      select 1
      from student_trip_status sts
      join daily_trips t on t.id = sts.trip_id
      where sts.student_id = new.student_id
        and t.date = new.date
        and t.status in ('active', 'completed')
    ) then
      -- The van is out. Only a coordinator can change anything now, because the
      -- driver is already working from the roster as it stands.
      new.approval := 'pending';
    elsif now() <= cutoff or new.date > current_date then
      new.approval := 'auto_approved';
      new.reviewed_at := now();
    else
      -- Past the wall-clock cutoff, but the van has NOT left. This is the window
      -- the old rule got wrong, and it is the common case: a parent noticing at
      -- 07:00 that their child is ill.
      new.approval := 'auto_approved';
      new.reviewed_at := now();
    end if;

    span := case
      when new.end_date is null or new.end_date = new.date then new.date::text
      else new.date::text || ' to ' || new.end_date::text
    end;

    if new.approval = 'pending' then
      insert into notifications (user_id, title, body, kind)
      select p.id, 'Change needs approval — the van has already left',
             (select full_name from profiles where id = new.student_id)
               || ' — ' || new.kind::text || ' for ' || span || '.',
             'approval'
      from profiles p where p.role in ('coordinator', 'admin') and p.status = 'active';
    end if;

    return new;
  end if;

  span := case
    when new.end_date is null or new.end_date = new.date then new.date::text
    else new.date::text || ' to ' || new.end_date::text
  end;

  if now() <= cutoff then
    new.approval := 'auto_approved';
    new.reviewed_at := now();
  else
    -- Blueprint §4.2: "Late changes require coordinator approval and should show
    -- Pending until resolved."
    new.approval := 'pending';

    insert into notifications (user_id, title, body, kind)
    select p.id, 'Late change needs approval',
           (select full_name from profiles where id = new.student_id)
             || ' — ' || new.kind::text || ' for ' || span || '.',
           'approval'
    from profiles p where p.role in ('coordinator', 'admin') and p.status = 'active';
  end if;

  return new;
end;
$$;
drop trigger if exists on_change_request_created on change_requests;
create trigger on_change_request_created before insert on change_requests
  for each row execute function decide_change_request();

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
      -- S2: a no-show after a CHECK-IN is not the same event as a no-show from
      -- nothing. The first means the child told us they were at the hub and then
      -- was not picked up — somebody should be looking for them. The second
      -- usually means they stayed home and nobody said. Same status, because
      -- splitting it would double every downstream branch; different escalation,
      -- because they are different emergencies.
      if new.check_in_time is not null then
        title := 'URGENT — ' || student_name || ' checked in but was not picked up';
        body  := student_name || ' said they were at the hub at '
                 || to_char(new.check_in_time, 'HH12:MI AM')
                 || ' and the driver recorded a no-show at ' || when_txt
                 || '. Nobody knows where they are.';
        kind_txt := 'no_show_after_checkin';
      else
        title := student_name || ' did not appear at the hub';
        body  := 'The driver recorded a no-show at ' || when_txt || '.';
      end if;
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

create or replace function guard_boarding_after_away() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'boarded'
     and old.status in ('absent', 'parent_pickup', 'no_show')
     -- The note must be non-empty AND NEW.
     --
     -- `note` is one column shared by every path that writes this row, and
     -- apply_change_request() already puts the ABSENCE REASON in it ("Ill.").
     -- Checking only that it is non-empty therefore passed on a note left behind
     -- by a different action entirely — and notify_on_rider_status() would then
     -- have told the parents "Ill. Boarded at 3:42 PM", presenting the reason
     -- they were marked absent as the driver's explanation for carrying them.
     -- A note that has not changed is not an explanation for THIS write.
     and (coalesce(btrim(new.note), '') = '' or new.note is not distinct from old.note) then
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

create or replace function notify_on_announcement() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into notifications (user_id, title, body, kind)
  select distinct u.id, new.title, new.body, 'announcement'
  from (
    -- One child in particular: them and their guardians, nobody else.
    select p.id from profiles p
    where new.student_id is not null
      and p.status = 'active'
      and (p.id = new.student_id or is_guardian_of_by(p.id, new.student_id))

    union

    -- One route: today's riders on it, their guardians, and its driver.
    select x.id from (
      select sts.student_id as id from student_trip_status sts
      join daily_trips t on t.id = sts.trip_id
      where new.student_id is null and new.route_id is not null
        and t.route_id = new.route_id and t.date >= current_date
      union
      select gl.parent_id from student_trip_status sts
      join daily_trips t on t.id = sts.trip_id
      join guardian_links gl on gl.student_id = sts.student_id and gl.status = 'accepted'
      where new.student_id is null and new.route_id is not null
        and t.route_id = new.route_id and t.date >= current_date
      union
      select t.driver_id from daily_trips t
      where new.student_id is null and new.route_id is not null
        and t.route_id = new.route_id and t.date >= current_date
    ) x
    join profiles p on p.id = x.id and p.status = 'active'

    union

    -- Untargeted: everybody, which is now a deliberate choice rather than the
    -- only behaviour available.
    select p.id from profiles p
    where new.student_id is null and new.route_id is null
      and p.status = 'active'
      and p.role in ('student', 'parent', 'driver')
  ) u
  where u.id is not null;

  return new;
end;
$$;
drop trigger if exists on_announcement_posted on announcements;
create trigger on_announcement_posted after insert on announcements
  for each row execute function notify_on_announcement();

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
  if tg_op = 'UPDATE' and not is_staff() and not undoing() then
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

create or replace function guard_rider_transition() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ok boolean;
begin
  if new.status = old.status then
    return new;
  end if;

  -- Blueprint §2.1: staff may override an official status, and already must give
  -- a reason for it. The exception queue is where a genuinely stuck record gets
  -- unstuck, and it cannot do that job through this table.
  if is_staff() or undoing() then
    return new;
  end if;

  select true into ok from (values
    -- Getting ready
    ('scheduled',         'waiting'),            -- the student checks in
    ('scheduled',         'boarded'),            -- boarded without checking in
    ('scheduled',         'absent'),
    ('scheduled',         'parent_pickup'),
    ('scheduled',         'no_show'),
    ('waiting',           'boarded'),
    ('waiting',           'absent'),
    ('waiting',           'parent_pickup'),
    ('waiting',           'no_show'),
    -- On the van
    ('boarded',           'in_transit'),         -- the van leaves their stop
    ('boarded',           'dropped_off'),        -- let off before it ever moved
    ('boarded',           'parent_pickup'),      -- parent arrives and takes them off again
    ('boarded',           'unable_to_drop_off'),
    ('in_transit',        'dropped_off'),
    ('in_transit',        'unable_to_drop_off'),
    -- Finishing
    ('dropped_off',       'completed'),          -- set by guard_trip_completion
    -- Turned up after all (C4). The note is separately mandatory.
    ('absent',            'boarded'),
    ('parent_pickup',     'boarded'),
    ('no_show',           'boarded'),
    -- Only a coordinator clears this one, and is_staff() already returned above.
    ('unable_to_drop_off','dropped_off')
  ) as t(from_status, to_status)
  where t.from_status = old.status::text
    and t.to_status   = new.status::text;

  if not coalesce(ok, false) then
    raise exception
      'A student cannot go from % to %. That is not a step this system allows.',
      replace(old.status::text, '_', ' '), replace(new.status::text, '_', ' ');
  end if;

  return new;
end;
$$;
drop trigger if exists on_rider_transition on student_trip_status;
create trigger on_rider_transition before update on student_trip_status
  for each row execute function guard_rider_transition();

create or replace function undo_rider_status(row_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  row student_trip_status%rowtype;
  entry audit_logs%rowtype;
  window_sec int;
  previous rider_status;
begin
  select * into row from student_trip_status where id = row_id;
  if row is null then
    raise exception 'That student record no longer exists.';
  end if;

  if not (drives_trip(row.trip_id) or is_staff()) then
    raise exception 'Only the driver of this trip, or the transport office, can undo it.';
  end if;

  select coalesce(undo_window_sec, 90) into window_sec from organization where id = 1;

  -- The most recent status change on this row. `old_value` already holds what it
  -- was, which is why this needs no new bookkeeping table.
  select * into entry from audit_logs
  where entity_type = 'student_trip_status' and entity_id = row_id and action = 'status_change'
  order by changed_at desc limit 1;

  if entry is null then
    raise exception 'There is nothing to undo for this student.';
  end if;
  if now() - entry.changed_at > make_interval(secs => window_sec) then
    raise exception
      'Too late to undo — that was more than % seconds ago. Ask the transport office to change it.',
      window_sec;
  end if;

  previous := (entry.old_value ->> 'status')::rider_status;

  perform set_config('app.undoing', 'on', true);

  update student_trip_status
  set status = previous,
      -- The timestamps the reverted status implies it does not have.
      board_time   = case when previous in ('boarded', 'in_transit') then board_time else null end,
      dropoff_time = case when previous in ('dropped_off', 'completed') then dropoff_time else null end,
      updated_by   = auth.uid(),
      updated_at   = now()
  where id = row_id;

  insert into audit_logs (entity_type, entity_id, action, old_value, new_value, reason, changed_by)
  values (
    'student_trip_status', row_id, 'status_undo',
    jsonb_build_object('status', row.status),
    jsonb_build_object('status', previous),
    'Undone by the driver within the ' || window_sec || ' second window.',
    auth.uid()
  );

  return jsonb_build_object('undone', true, 'from', row.status, 'to', previous);
end;
$$;
grant execute on function undo_rider_status(uuid) to authenticated;

create or replace function undo_stop_progress(target_trip uuid, target_stop uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  prog trip_stop_progress%rowtype;
  window_sec int;
  undone text;
begin
  if not (drives_trip(target_trip) or is_staff()) then
    raise exception 'Only the driver of this trip, or the transport office, can undo it.';
  end if;

  select * into prog from trip_stop_progress
  where trip_id = target_trip and stop_id = target_stop;
  if prog is null then
    raise exception 'Nothing has been recorded at this stop yet.';
  end if;

  select coalesce(undo_window_sec, 90) into window_sec from organization where id = 1;

  perform set_config('app.undoing', 'on', true);

  -- Most recent action first: a departure is undone before an arrival, because
  -- the departure is what the driver just did.
  if prog.departed_at is not null then
    if now() - prog.departed_at > make_interval(secs => window_sec) and not is_staff() then
      raise exception 'Too late to undo leaving this stop. Ask the transport office.';
    end if;

    update trip_stop_progress
    set departed_at = null, departed_with_unresolved = false, skipped = false
    where id = prog.id;

    -- Leaving promoted everyone who boarded here to in_transit. Un-leaving has
    -- to put them back, or the roster says the van moved and the record says it
    -- did not.
    update student_trip_status
    set status = 'boarded', updated_by = auth.uid(), updated_at = now()
    where trip_id = target_trip and pickup_stop_id = target_stop and status = 'in_transit';

    undone := 'departure';
  elsif prog.arrived_at is not null then
    if now() - prog.arrived_at > make_interval(secs => window_sec) and not is_staff() then
      raise exception 'Too late to undo arriving at this stop. Ask the transport office.';
    end if;

    update trip_stop_progress set arrived_at = null where id = prog.id;
    undone := 'arrival';
  else
    raise exception 'Nothing has been recorded at this stop yet.';
  end if;

  insert into audit_logs (entity_type, entity_id, action, old_value, new_value, reason, changed_by)
  values (
    'trip_stop_progress', prog.id, 'stop_progress_undo',
    jsonb_build_object('arrived_at', prog.arrived_at, 'departed_at', prog.departed_at),
    jsonb_build_object('undone', undone),
    'Stop ' || undone || ' undone within the ' || window_sec || ' second window.',
    auth.uid()
  );

  return jsonb_build_object('undone', undone);
end;
$$;
grant execute on function undo_stop_progress(uuid, uuid) to authenticated;

create or replace function transport_watchdog() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cfg organization%rowtype;
  raised int;
  result jsonb := '{}'::jsonb;
  cleared int;
begin
  -- Callable by hand from the office ("check now"), and by cron, which has no
  -- auth.uid() at all. Anyone else signed in gets nothing.
  if auth.uid() is not null and not is_staff() then
    raise exception 'Only the transport office can run the watchdog.';
  end if;

  select * into cfg from organization where id = 1;
  if cfg is null or not cfg.watchdog_enabled then
    return jsonb_build_object('ran', false, 'reason', 'The watchdog is switched off.');
  end if;

  -- -------------------------------------------------------------------------
  -- 1. The trip that should have left and has not been started.
  -- -------------------------------------------------------------------------
  insert into watchdog_alerts (trip_id, stop_id, kind, detail)
  select t.id, fs.id, 'trip_not_started',
         rt.name || ' was due to leave ' || coalesce(h.name, s.name, 'its first stop')
           || ' at ' || to_char(fs.planned_departure, 'HH12:MI AM')
           || ' and the driver has not started the trip.'
  from daily_trips t
  join route_templates rt on rt.id = t.route_id
  join lateral (
    select rs.* from route_stops rs where rs.route_id = t.route_id order by rs.seq limit 1
  ) fs on true
  left join hubs    h on h.id = fs.hub_id
  left join schools s on s.id = fs.school_id
  where t.date = current_date
    and t.status = 'scheduled'
    and fs.planned_departure is not null
    and now() > (t.date + fs.planned_departure)::timestamptz
                + make_interval(mins => cfg.watchdog_trip_start_min)
    -- A trip with nobody on it is not an emergency.
    and exists (select 1 from student_trip_status x where x.trip_id = t.id)
  on conflict do nothing;
  get diagnostics raised = row_count;
  result := result || jsonb_build_object('trip_not_started', raised);

  -- -------------------------------------------------------------------------
  -- 2. The stop with riders on it that the van has not reached.
  -- -------------------------------------------------------------------------
  insert into watchdog_alerts (trip_id, stop_id, kind, detail)
  select t.id, rs.id, 'stop_not_reached',
         rt.name || ' was due at ' || coalesce(h.name, s.name, 'a stop')
           || ' at ' || to_char(rs.planned_arrival, 'HH12:MI AM')
           || ' and has not arrived. '
           -- The same "who has no outcome here" rule the departure guard uses,
           -- so it counts riders due to get OFF as well as riders due to get on.
           || (select count(*) from riders_unresolved_at_stop(t.id, rs.id))::text
           || ' student(s) are still due at this stop.'
  from daily_trips t
  join route_templates rt on rt.id = t.route_id
  join route_stops rs on rs.route_id = t.route_id
  left join hubs    h on h.id = rs.hub_id
  left join schools s on s.id = rs.school_id
  left join trip_stop_progress p on p.trip_id = t.id and p.stop_id = rs.id
  where t.date = current_date
    and t.status = 'active'
    and rs.planned_arrival is not null
    and p.arrived_at is null
    and coalesce(p.skipped, false) = false
    -- The school on an AFTERNOON route is the ORIGIN: the van starts there, so
    -- the driver never marks an arrival and never will. Without this the
    -- watchdog would raise a false alarm on every single afternoon run, which is
    -- the fastest way to teach a coordinator to ignore it. Mirrors `isOrigin` on
    -- the driver's trip screen.
    and not (rs.school_id is not null and rt.type = 'afternoon')
    and now() > (t.date + rs.planned_arrival)::timestamptz
                + make_interval(mins => cfg.watchdog_stop_arrival_min)
    and exists (
      select 1 from student_trip_status x
      where x.trip_id = t.id
        and (x.pickup_stop_id = rs.id or x.dropoff_stop_id = rs.id)
        and x.status not in ('absent', 'parent_pickup')
    )
  on conflict do nothing;
  get diagnostics raised = row_count;
  result := result || jsonb_build_object('stop_not_reached', raised);

  -- -------------------------------------------------------------------------
  -- 3. The student who said they were at the hub, and still is.
  --
  -- The one the whole plan keeps coming back to: the app KNOWS this child is
  -- standing outside, because they told it.
  -- -------------------------------------------------------------------------
  insert into watchdog_alerts (trip_id, stop_id, student_id, kind, detail)
  select sts.trip_id, sts.pickup_stop_id, sts.student_id, 'rider_waiting',
         coalesce(nullif(pr.full_name, ''), 'A student')
           || ' checked in at ' || coalesce(h.name, s.name, 'their hub')
           || ' at ' || to_char(sts.check_in_time, 'HH12:MI AM')
           || ' and has not been boarded since.'
  from student_trip_status sts
  join daily_trips t on t.id = sts.trip_id
  join profiles pr on pr.id = sts.student_id
  left join route_stops rs on rs.id = sts.pickup_stop_id
  left join hubs    h on h.id = rs.hub_id
  left join schools s on s.id = rs.school_id
  where t.date = current_date
    and sts.status = 'waiting'
    and sts.check_in_time is not null
    and now() - sts.check_in_time > make_interval(mins => cfg.watchdog_waiting_min)
  on conflict do nothing;
  get diagnostics raised = row_count;
  result := result || jsonb_build_object('rider_waiting', raised);

  -- -------------------------------------------------------------------------
  -- 4. The trip that never ended. This is the pocketed phone.
  -- -------------------------------------------------------------------------
  insert into watchdog_alerts (trip_id, kind, detail)
  select t.id, 'trip_overrunning',
         rt.name || ' has been running for '
           || round(extract(epoch from (now() - t.started_at)) / 60)::text
           || ' minutes and has not been ended. '
           || (select count(*) from student_trip_status x
               where x.trip_id = t.id and x.status in ('boarded', 'in_transit'))::text
           || ' student(s) are still recorded as on board.'
  from daily_trips t
  join route_templates rt on rt.id = t.route_id
  where t.date = current_date
    and t.status = 'active'
    and t.started_at is not null
    and now() - t.started_at > make_interval(mins => cfg.watchdog_trip_max_min)
  on conflict do nothing;
  get diagnostics raised = row_count;
  result := result || jsonb_build_object('trip_overrunning', raised);

  -- -------------------------------------------------------------------------
  -- 5. The van finished its route and somebody is still on it.
  -- -------------------------------------------------------------------------
  insert into watchdog_alerts (trip_id, stop_id, student_id, kind, detail)
  select sts.trip_id, fin.stop_id, sts.student_id, 'rider_still_onboard',
         coalesce(nullif(pr.full_name, ''), 'A student')
           || ' is still recorded as on board ' || rt.name
           || ', which reached its last stop at '
           || to_char(fin.at_time, 'HH12:MI AM') || '.'
  from student_trip_status sts
  join daily_trips t on t.id = sts.trip_id
  join route_templates rt on rt.id = t.route_id
  join profiles pr on pr.id = sts.student_id
  join lateral (
    select rs.id as stop_id, coalesce(p.departed_at, p.arrived_at) as at_time
    from route_stops rs
    join trip_stop_progress p on p.trip_id = t.id and p.stop_id = rs.id
    where rs.route_id = t.route_id
    order by rs.seq desc
    limit 1
  ) fin on true
  where t.date = current_date
    and sts.status in ('boarded', 'in_transit')
    and fin.at_time is not null
    and now() - fin.at_time > make_interval(mins => cfg.watchdog_onboard_min)
  on conflict do nothing;
  get diagnostics raised = row_count;
  result := result || jsonb_build_object('rider_still_onboard', raised);

  -- -------------------------------------------------------------------------
  -- 6. S6 — an URGENT notification nobody has acknowledged.
  --
  -- Push is best-effort: a flat battery, a revoked token, a phone face-down on a
  -- table. For "could not drop off" and "checked in then not picked up", sending
  -- is not the same as telling, so silence past a few minutes is itself an
  -- event.
  -- -------------------------------------------------------------------------
  insert into watchdog_alerts (notification_id, kind, detail)
  select n.id, 'urgent_unacknowledged',
         coalesce(nullif(p.full_name, ''), 'Someone')
           || ' has not acknowledged: "' || n.title || '" (sent '
           || to_char(n.created_at, 'HH12:MI AM') || ', '
           || case n.delivery_state
                when 'no_token' then 'no push token on file for them'
                when 'failed'   then 'push delivery failed'
                when 'sent'     then 'push delivered, not opened'
                else 'push not yet attempted'
              end
           || '). Phone them.'
  from notifications n
  join profiles p on p.id = n.user_id
  where n.requires_ack
    and n.acknowledged_at is null
    and now() - n.created_at > interval '5 minutes'
  on conflict do nothing;
  get diagnostics raised = row_count;
  result := result || jsonb_build_object('unacknowledged_urgent', raised);

  -- -------------------------------------------------------------------------
  -- Self-clearing. An alert about something that has since sorted itself out is
  -- noise, and a queue of noise is a queue nobody reads.
  -- -------------------------------------------------------------------------
  update watchdog_alerts a
  set resolved_at = now(),
      resolution  = 'Cleared automatically — the condition went away.'
  where a.resolved_at is null
    and case a.kind
      when 'trip_not_started' then
        exists (select 1 from daily_trips t where t.id = a.trip_id and t.status <> 'scheduled')
      when 'stop_not_reached' then
        exists (select 1 from trip_stop_progress p
                where p.trip_id = a.trip_id and p.stop_id = a.stop_id
                  and (p.arrived_at is not null or p.skipped))
      when 'rider_waiting' then
        exists (select 1 from student_trip_status x
                where x.trip_id = a.trip_id and x.student_id = a.student_id
                  and x.status <> 'waiting')
      when 'trip_overrunning' then
        exists (select 1 from daily_trips t where t.id = a.trip_id and t.status <> 'active')
      when 'rider_still_onboard' then
        exists (select 1 from student_trip_status x
                where x.trip_id = a.trip_id and x.student_id = a.student_id
                  and x.status not in ('boarded', 'in_transit'))
      when 'urgent_unacknowledged' then
        exists (select 1 from notifications n
                where n.id = a.notification_id and n.acknowledged_at is not null)
      else false
    end;
  get diagnostics cleared = row_count;

  -- -------------------------------------------------------------------------
  -- Tell the office. Once per alert, ever — `notified_at` is the latch.
  -- -------------------------------------------------------------------------
  insert into notifications (user_id, title, body, kind)
  select p.id,
         case a.kind
           when 'trip_not_started'    then 'Route has not started'
           when 'stop_not_reached'    then 'Van is overdue at a stop'
           when 'rider_waiting'       then 'Student still waiting at a hub'
           when 'trip_overrunning'    then 'Trip has not been ended'
           when 'rider_still_onboard' then 'Student still on board after the route ended'
           when 'urgent_unacknowledged' then 'An urgent message has gone unanswered'
         end,
         a.detail,
         'watchdog'
  from watchdog_alerts a
  cross join profiles p
  where a.notified_at is null
    and a.resolved_at is null
    and p.role in ('coordinator', 'admin')
    and p.status = 'active';

  update watchdog_alerts set notified_at = now() where notified_at is null;

  return result || jsonb_build_object('ran', true, 'cleared', cleared, 'at', now());
end;
$$;
grant execute on function transport_watchdog() to authenticated;

create or replace function watchdog_schedule_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  installed boolean;
  sched text;
begin
  select exists (select 1 from pg_extension where extname = 'pg_cron') into installed;

  if not installed then
    return jsonb_build_object(
      'installed', false,
      'enabled', false,
      'hint', 'pg_cron is not enabled. Supabase dashboard → Database → Extensions → enable pg_cron, then come back.'
    );
  end if;

  execute $q$ select schedule from cron.job where jobname = 'transport-watchdog' $q$ into sched;

  return jsonb_build_object('installed', true, 'enabled', sched is not null, 'schedule', sched);
end;
$$;

create or replace function set_watchdog_schedule(enable boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  installed boolean;
begin
  if not is_staff() then
    raise exception 'Only the transport office can change the watchdog schedule.';
  end if;

  select exists (select 1 from pg_extension where extname = 'pg_cron') into installed;
  if not installed then
    raise exception 'pg_cron is not enabled on this project. Dashboard → Database → Extensions → enable pg_cron, then try again.';
  end if;

  if enable then
    execute $q$
      select cron.schedule(
        'transport-watchdog',
        '*/5 6-19 * * 1-5',
        'select transport_watchdog()'
      )
    $q$;
  else
    begin
      execute $q$ select cron.unschedule('transport-watchdog') $q$;
    exception when others then
      null;  -- already gone
    end;
  end if;

  insert into audit_logs (entity_type, action, new_value, reason, changed_by)
  values (
    'system',
    case when enable then 'watchdog_schedule_enabled' else 'watchdog_schedule_disabled' end,
    jsonb_build_object('enabled', enable),
    'Watchdog schedule changed from the transport office.',
    auth.uid()
  );

  return watchdog_schedule_status();
end;
$$;
grant execute on function watchdog_schedule_status() to authenticated;
grant execute on function set_watchdog_schedule(boolean) to authenticated;

create or replace function send_arrival_alerts() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sent int := 0;
  batch int;
  milestone int;
begin
  if auth.uid() is not null and not is_staff() then
    raise exception 'Only the transport office can send arrival alerts.';
  end if;

  foreach milestone in array array[15, 5] loop
    with due as (
      select t.id as trip_id, rs.id as stop_id,
             coalesce(h.name, s.name, 'the stop') as stop_name,
             -- S1: a reported delay shifts every remaining planned time, so a
             -- late van does not keep sending confidently wrong alerts.
             (t.date + rs.planned_arrival)::timestamptz
               + make_interval(mins => coalesce(t.delay_minutes, 0)) as due_at
      from daily_trips t
      join route_stops rs on rs.route_id = t.route_id
      left join hubs    h on h.id = rs.hub_id
      left join schools s on s.id = rs.school_id
      where t.date = current_date
        and t.status in ('scheduled', 'active')
        and rs.planned_arrival is not null
    ),
    ready as (
      select * from due
      -- Fires on the first pass at or after the milestone, and stops firing once
      -- the van is actually due. A cron tick every five minutes lands in here.
      where now() >= due_at - make_interval(mins => milestone)
        and now() <  due_at
    ),
    claimed as (
      insert into arrival_alerts (trip_id, stop_id, minutes)
      select trip_id, stop_id, milestone from ready
      on conflict do nothing
      returning trip_id, stop_id
    ),
    -- Who is actually still expecting this van here. Away students are excluded,
    -- which the local version never did.
    riders as (
      select c.trip_id, c.stop_id, sts.student_id, pr.full_name as student_name,
             r.stop_name, r.due_at
      from claimed c
      join ready r on r.trip_id = c.trip_id and r.stop_id = c.stop_id
      join student_trip_status sts
        on sts.trip_id = c.trip_id and sts.pickup_stop_id = c.stop_id
      join profiles pr on pr.id = sts.student_id
      where sts.status in ('scheduled', 'waiting')
    ),
    -- N1: one row per RECIPIENT per stop, listing whoever it covers. Two
    -- children at the same hub is one notification naming both.
    audience as (
      select gl.parent_id as user_id, r.stop_name, r.due_at,
             string_agg(distinct r.student_name, ' and ') as who
      from riders r
      join guardian_links gl on gl.student_id = r.student_id and gl.status = 'accepted'
      group by gl.parent_id, r.stop_id, r.stop_name, r.due_at
      union all
      select r.student_id, r.stop_name, r.due_at, null
      from riders r
    )
    insert into notifications (user_id, title, body, kind)
    select a.user_id,
           coalesce(a.who || '''s van', 'Your van') || ' is due in ' || milestone || ' minutes',
           'Expected at ' || a.stop_name || ' at ' || to_char(a.due_at, 'HH12:MI AM') || '.',
           'arrival'
    from audience a;

    get diagnostics batch = row_count;
    sent := sent + batch;
  end loop;

  return jsonb_build_object('ran', true, 'notifications', sent, 'at', now());
end;
$$;
grant execute on function send_arrival_alerts() to authenticated;

create or replace function report_delay(target_trip uuid, minutes int, reason text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t daily_trips%rowtype;
  route_name text;
  total int;
begin
  select * into t from daily_trips where id = target_trip;
  if t is null then
    raise exception 'That trip does not exist.';
  end if;
  if not (drives_trip(target_trip) or is_staff()) then
    raise exception 'Only the driver of this trip, or the transport office, can report a delay.';
  end if;
  if minutes is null or minutes <= 0 then
    raise exception 'A delay has to be a number of minutes.';
  end if;

  -- Cumulative. Twenty minutes of traffic followed by another ten is thirty, not
  -- ten — the driver is reporting what just happened, not restating the total.
  total := coalesce(t.delay_minutes, 0) + minutes;

  update daily_trips
  set delay_minutes = total,
      delay_reason  = coalesce(nullif(btrim(reason), ''), delay_reason)
  where id = target_trip;

  select rt.name into route_name from route_templates rt where rt.id = t.route_id;

  -- Everyone still expecting this van hears the new time for THEIR stop, not a
  -- generic "we are late".
  insert into notifications (user_id, title, body, kind)
  select a.user_id,
         route_name || ' is running ' || total || ' minutes late',
         'Now expected at ' || a.stop_name || ' about '
           || to_char(a.due_at, 'HH12:MI AM') || '.'
           || coalesce(' ' || nullif(btrim(reason), ''), ''),
         'delay'
  from (
    select gl.parent_id as user_id,
           coalesce(h.name, s.name, 'your stop') as stop_name,
           (t.date + rs.planned_arrival)::timestamptz + make_interval(mins => total) as due_at
    from student_trip_status sts
    join route_stops rs on rs.id = coalesce(sts.pickup_stop_id, sts.dropoff_stop_id)
    left join hubs    h on h.id = rs.hub_id
    left join schools s on s.id = rs.school_id
    join guardian_links gl on gl.student_id = sts.student_id and gl.status = 'accepted'
    where sts.trip_id = target_trip
      and sts.status not in ('absent', 'parent_pickup', 'no_show', 'dropped_off', 'completed')
      and rs.planned_arrival is not null
    union
    select sts.student_id,
           coalesce(h.name, s.name, 'your stop'),
           (t.date + rs.planned_arrival)::timestamptz + make_interval(mins => total)
    from student_trip_status sts
    join route_stops rs on rs.id = coalesce(sts.pickup_stop_id, sts.dropoff_stop_id)
    left join hubs    h on h.id = rs.hub_id
    left join schools s on s.id = rs.school_id
    where sts.trip_id = target_trip
      and sts.status not in ('absent', 'parent_pickup', 'no_show', 'dropped_off', 'completed')
      and rs.planned_arrival is not null
  ) a;

  -- Alerts already sent for this trip were based on the OLD time, so let the
  -- shifted ones fire again. This is the whole reason the delay is structured.
  delete from arrival_alerts where trip_id = target_trip;

  insert into audit_logs (entity_type, entity_id, action, new_value, reason, changed_by)
  values ('daily_trips', target_trip, 'delay_reported',
          jsonb_build_object('added', minutes, 'total', total),
          reason, auth.uid());

  return jsonb_build_object('delay_minutes', total);
end;
$$;
grant execute on function report_delay(uuid, int, text) to authenticated;

create or replace function notify_on_stop_departure() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  stop_name text;
begin
  if new.departed_at is null then return new; end if;
  if tg_op = 'UPDATE' and old.departed_at is not null then return new; end if;

  select coalesce(h.name, s.name, 'the stop') into stop_name
  from route_stops rs
  left join hubs    h on h.id = rs.hub_id
  left join schools s on s.id = rs.school_id
  where rs.id = new.stop_id;

  -- Grouped per guardian (N1): a parent with two children on the same van gets
  -- one message naming both, not two pushes a second apart.
  insert into notifications (user_id, title, body, kind)
  select gl.parent_id,
         string_agg(distinct coalesce(nullif(pr.full_name, ''), 'Your child'), ' and ')
           -- Past simple reads correctly for one child or several; "has left"
           -- does not once the names are collapsed.
           || ' left ' || stop_name,
         'The van pulled away at ' || to_char(new.departed_at, 'HH12:MI AM') || '.',
         'in_transit'
  from student_trip_status sts
  join profiles pr on pr.id = sts.student_id
  join guardian_links gl on gl.student_id = sts.student_id and gl.status = 'accepted'
  where sts.trip_id = new.trip_id
    and sts.pickup_stop_id = new.stop_id
    and sts.status in ('boarded', 'in_transit')
  group by gl.parent_id;

  return new;
end;
$$;
drop trigger if exists on_stop_departed on trip_stop_progress;
create trigger on_stop_departed after insert or update on trip_stop_progress
  for each row execute function notify_on_stop_departure();

create or replace function arrival_schedule_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  installed boolean;
  sched text;
begin
  select exists (select 1 from pg_extension where extname = 'pg_cron') into installed;
  if not installed then
    return jsonb_build_object('installed', false, 'enabled', false,
      'hint', 'pg_cron is not enabled. Supabase dashboard → Database → Extensions → enable pg_cron, then come back.');
  end if;
  execute $q$ select schedule from cron.job where jobname = 'arrival-alerts' $q$ into sched;
  return jsonb_build_object('installed', true, 'enabled', sched is not null, 'schedule', sched);
end;
$$;

create or replace function set_arrival_schedule(enable boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then
    raise exception 'Only the transport office can change the alert schedule.';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is not enabled on this project. Dashboard → Database → Extensions → enable pg_cron, then try again.';
  end if;

  if enable then
    -- Every two minutes: the 5-minute milestone needs finer resolution than the
    -- watchdog's five-minute tick or it lands late enough to be useless.
    execute $q$
      select cron.schedule('arrival-alerts', '*/2 6-19 * * 1-5', 'select send_arrival_alerts()')
    $q$;
  else
    begin
      execute $q$ select cron.unschedule('arrival-alerts') $q$;
    exception when others then null;
    end;
  end if;

  return arrival_schedule_status();
end;
$$;
grant execute on function arrival_schedule_status() to authenticated;
grant execute on function set_arrival_schedule(boolean) to authenticated;

create or replace function find_rider_today(search text)
returns table (
  status_id    uuid,
  student_name text,
  route_name   text,
  route_kind   route_type,
  driver_name  text,
  hub_name     text,
  rider_status rider_status,
  is_mine      boolean
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (my_role() in ('driver', 'coordinator', 'admin') and is_active()) then
    raise exception 'Only a driver or the transport office can look a rider up.';
  end if;
  if coalesce(btrim(search), '') = '' or length(btrim(search)) < 2 then
    raise exception 'Type at least two letters of their name.';
  end if;

  return query
  select sts.id,
         coalesce(nullif(p.full_name, ''), 'A student'),
         rt.name,
         rt.type,
         coalesce(nullif(dp.full_name, ''), 'No driver assigned'),
         coalesce(h.name, s.name, 'their stop'),
         sts.status,
         t.driver_id = auth.uid()
  from student_trip_status sts
  join daily_trips t on t.id = sts.trip_id
  join route_templates rt on rt.id = t.route_id
  join profiles p on p.id = sts.student_id
  left join profiles dp on dp.id = t.driver_id
  left join route_stops rs on rs.id = sts.pickup_stop_id
  left join hubs    h on h.id = rs.hub_id
  left join schools s on s.id = rs.school_id
  where t.date = current_date
    and p.full_name ilike '%' || btrim(search) || '%'
  order by (t.driver_id = auth.uid()) desc, p.full_name
  limit 10;
end;
$$;
grant execute on function find_rider_today(text) to authenticated;

create or replace function move_rider_to_trip(status_id uuid, target_trip uuid, reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sts student_trip_status%rowtype;
begin
  if not is_staff() then
    raise exception 'Only the transport office can move a student between vans.';
  end if;
  if coalesce(btrim(reason), '') = '' then
    raise exception 'Moving a child to a different van needs a reason.';
  end if;

  select * into sts from student_trip_status where id = status_id;
  if sts is null then
    raise exception 'That student record no longer exists.';
  end if;

  update student_trip_status
  set trip_id = target_trip,
      -- The stops belong to the OLD route and mean nothing on the new one. The
      -- office re-seats them; leaving stale ids would put the child at a stop
      -- that is not on the van they are now on.
      pickup_stop_id = null,
      dropoff_stop_id = null,
      note = 'Moved between vans: ' || btrim(reason),
      updated_by = auth.uid(),
      updated_at = now()
  where id = status_id;

  insert into audit_logs (entity_type, entity_id, action, old_value, new_value, reason, changed_by)
  values ('student_trip_status', status_id, 'moved_trip',
          jsonb_build_object('trip_id', sts.trip_id),
          jsonb_build_object('trip_id', target_trip),
          btrim(reason), auth.uid());

  return jsonb_build_object('moved', true);
end;
$$;
grant execute on function move_rider_to_trip(uuid, uuid, text) to authenticated;

create or replace function board_at_other_stop(status_id uuid, actual_stop uuid, reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sts student_trip_status%rowtype;
  original text;
begin
  select * into sts from student_trip_status where id = status_id;
  if sts is null then
    raise exception 'That student record no longer exists.';
  end if;
  if not (drives_trip(sts.trip_id) or is_staff()) then
    raise exception 'Only the driver of this trip can board a student onto it.';
  end if;
  if coalesce(btrim(reason), '') = '' then
    raise exception 'Boarding a student at a different stop needs a note.';
  end if;

  select coalesce(h.name, s.name, 'their usual stop') into original
  from route_stops rs
  left join hubs    h on h.id = rs.hub_id
  left join schools s on s.id = rs.school_id
  where rs.id = sts.pickup_stop_id;

  update student_trip_status
  set status = 'boarded',
      pickup_stop_id = actual_stop,
      board_time = now(),
      note = 'Boarded at a different stop (usually ' || coalesce(original, 'elsewhere') || '): '
             || btrim(reason),
      updated_by = auth.uid(),
      updated_at = now()
  where id = status_id;

  return jsonb_build_object('boarded', true, 'moved_from', original);
end;
$$;
grant execute on function board_at_other_stop(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- N2: checkin_window_min has existed with nothing behind it since the first
-- schema — a student could check in at 3am.
-- ---------------------------------------------------------------------------
drop policy if exists "students check in only" on student_trip_status;
create policy "students check in only" on student_trip_status for update
  using (is_active() and student_id = auth.uid())
  with check (
    is_active()
    and student_id = auth.uid()
    and status = 'waiting'
    and within_checkin_window(trip_id, pickup_stop_id)
  );
