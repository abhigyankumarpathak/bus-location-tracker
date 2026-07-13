-- Weekly report + purge.
--
-- SAFE TO RUN ON A LIVE DATABASE. This file is purely additive — it creates one
-- table and some functions, and drops nothing. Run it once, on top of
-- schema.sql, whether that database is fresh or already has real accounts in it.
--
-- ---------------------------------------------------------------------------
-- The idea
--
-- Operational tables grow forever. A term of three vans is tens of thousands of
-- rows of "student boarded, student dropped off, nothing happened" — which is
-- the overwhelming majority of the data and almost none of the value.
--
-- So once a week:
--   1. Every student's week is ARCHIVED into a single weekly_reports row.
--   2. Their parents (and the student) are sent that report.
--   3. Only then is the routine detail behind it purged.
--
-- The report is the history. Purging the rows underneath it does not erase a
-- child's record — it compacts it from ~10 rows a week to 1.
--
-- ---------------------------------------------------------------------------
-- What is NEVER purged
--
--   incidents            delays, breakdowns, accidents — the safety record
--   audit_logs (overrides) any status a coordinator changed, and why
--   change_requests      absences, parent pickups, club changes
--   weekly_reports       the archive itself
--   account_removals     why an account was removed
--   profiles, routes, hubs, vehicles, guardian_links — all configuration
--
-- A trip is "notable" and kept WHOLE — every row of it — if anything went wrong
-- on it: an incident was filed, a student was a no-show, or a student could not
-- be dropped off. Those are the days somebody will ask about later.
--
-- What is purged, and only when it is both old enough AND archived:
--
--   student_trip_status  routine rides on non-notable trips
--   daily_trips          the trips themselves, once empty
--   vehicle_locations    GPS breadcrumbs (the biggest table by far, when GPS is on)
--   notifications        ones already read
--   audit_logs           routine status changes with no reason attached
-- ---------------------------------------------------------------------------

-- How many weeks of full detail to keep before compacting. The current week is
-- never touched.
alter table organization
  add column if not exists retention_weeks int not null default 3;

comment on column organization.retention_weeks is
  'Weeks of full operational detail to keep. Older routine data is purged once archived into weekly_reports. Incidents and overrides are kept regardless.';

-- ---------------------------------------------------------------------------
-- The archive
-- ---------------------------------------------------------------------------

create table if not exists weekly_reports (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references profiles on delete cascade,
  week_start   date not null,          -- Monday
  week_end     date not null,          -- Sunday
  -- One entry per ride: date, route, how it ended, and the times.
  rides        jsonb not null default '[]'::jsonb,
  -- Counts, so the app does not have to walk the array to show a summary.
  totals       jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now(),
  unique (student_id, week_start)
);

create index if not exists weekly_reports_student_idx
  on weekly_reports (student_id, week_start desc);

alter table weekly_reports enable row level security;

drop policy if exists "read own reports" on weekly_reports;
create policy "read own reports" on weekly_reports for select using (
  (is_active() and (student_id = auth.uid() or is_guardian_of(student_id)))
  or is_staff()
);

-- Only the generator writes these, and it runs as SECURITY DEFINER.
drop policy if exists "staff manage reports" on weekly_reports;
create policy "staff manage reports" on weekly_reports for all
  using (is_staff()) with check (is_staff());

-- ---------------------------------------------------------------------------
-- Was anything worth remembering about this trip?
--
-- If so the whole trip is preserved, not just the row that went wrong — because
-- the question afterwards is always "what happened on that run", not "what
-- happened to that one child".
-- ---------------------------------------------------------------------------

create or replace function trip_is_notable(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select
    exists (select 1 from incidents i where i.trip_id = target)
    or exists (
      select 1 from student_trip_status s
      where s.trip_id = target
        and s.status in ('no_show', 'unable_to_drop_off')
    );
$$;

-- ---------------------------------------------------------------------------
-- Build the archive for one week (Monday..Sunday), and tell the families.
--
-- Idempotent: re-running it for the same week refreshes the report rather than
-- duplicating it, and does not re-notify.
-- ---------------------------------------------------------------------------

-- The parameter is prefixed because an unprefixed `week_start` would be
-- ambiguous against the column of the same name inside ON CONFLICT below.
create or replace function generate_weekly_reports(p_week_start date default null)
returns int
language plpgsql security definer set search_path = public as $$
declare
  ws date := coalesce(p_week_start, (date_trunc('week', current_date - interval '7 days'))::date);
  we date := ws + 6;
  made int := 0;
  is_new boolean;
  r record;
begin
  for r in
    select
      sts.student_id,
      jsonb_agg(
        jsonb_build_object(
          'date',         t.date,
          'route',        rt.name,
          'type',         rt.type,
          'status',       sts.status,
          'hub',          coalesce(h.name, sc.name),
          'check_in',     sts.check_in_time,
          'boarded',      sts.board_time,
          'dropped_off',  sts.dropoff_time,
          'note',         sts.note
        )
        order by t.date, rt.type
      ) as rides,
      count(*) filter (where sts.status in ('dropped_off', 'completed')) as completed,
      count(*) filter (where sts.status = 'absent')                      as absent,
      count(*) filter (where sts.status = 'parent_pickup')               as parent_pickup,
      count(*) filter (where sts.status = 'no_show')                     as no_show,
      count(*) filter (where sts.status = 'unable_to_drop_off')          as unable,
      count(*)                                                            as total
    from student_trip_status sts
    join daily_trips t      on t.id = sts.trip_id
    join route_templates rt on rt.id = t.route_id
    left join route_stops rs on rs.id = coalesce(sts.dropoff_stop_id, sts.pickup_stop_id)
    left join hubs h         on h.id = rs.hub_id
    left join schools sc     on sc.id = rs.school_id
    where t.date between ws and we
    group by sts.student_id
  loop
    insert into weekly_reports (student_id, week_start, week_end, rides, totals)
    values (
      r.student_id, ws, we, r.rides,
      jsonb_build_object(
        'total', r.total,
        'completed', r.completed,
        'absent', r.absent,
        'parent_pickup', r.parent_pickup,
        'no_show', r.no_show,
        'unable_to_drop_off', r.unable
      )
    )
    on conflict (student_id, week_start) do update
      set rides = excluded.rides,
          totals = excluded.totals,
          generated_at = now()
    -- xmax = 0 means this was an INSERT, not an UPDATE — so re-running the job
    -- refreshes a report without spamming the family a second time.
    returning (xmax = 0) into strict is_new;

    if is_new then
      -- The student, and every accepted guardian.
      insert into notifications (user_id, title, body, kind)
      select p, 'Weekly transport report',
             (select coalesce(nullif(full_name, ''), 'Your student') from profiles where id = r.student_id)
               || ' — ' || r.total || ' ride' || case when r.total = 1 then '' else 's' end
               || ' from ' || to_char(ws, 'Mon DD') || ' to ' || to_char(we, 'Mon DD') || '. '
               || r.completed || ' completed'
               || case when r.absent > 0        then ', ' || r.absent || ' absent' else '' end
               || case when r.parent_pickup > 0 then ', ' || r.parent_pickup || ' parent pickup' else '' end
               || case when r.no_show > 0       then ', ' || r.no_show || ' no-show' else '' end
               || '.',
             'weekly_report'
      from (
        select r.student_id as p
        union
        select gl.parent_id
        from guardian_links gl
        where gl.student_id = r.student_id and gl.status = 'accepted'
      ) audience;
    end if;
  end loop;

  select count(*) into made from weekly_reports where week_start = ws;
  return made;
end;
$$;

-- ---------------------------------------------------------------------------
-- Purge routine data that has already been archived.
--
-- Three independent guards, all of which must pass before a row is deleted:
--   1. It is older than retention_weeks.
--   2. Its trip is not notable.
--   3. Its week HAS a weekly_reports row for that student — i.e. the family has
--      been given the record before the detail behind it goes.
--
-- Guard 3 is the important one. Without it, a cron misfire or a changed
-- retention setting could delete a week nobody ever saw.
-- ---------------------------------------------------------------------------

create or replace function purge_routine_data()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  keep_weeks int;
  cutoff date;
  d_status int := 0;
  d_trips int := 0;
  d_locs int := 0;
  d_notifs int := 0;
  d_audit int := 0;
begin
  select retention_weeks into keep_weeks from organization where id = 1;
  cutoff := (date_trunc('week', current_date) - (keep_weeks || ' weeks')::interval)::date;

  -- Routine rides on unremarkable trips, but only where the week was archived.
  with gone as (
    delete from student_trip_status sts
    using daily_trips t
    where sts.trip_id = t.id
      and t.date < cutoff
      and not trip_is_notable(t.id)
      and exists (
        select 1 from weekly_reports wr
        where wr.student_id = sts.student_id
          and t.date between wr.week_start and wr.week_end
      )
    returning 1
  ) select count(*) into d_status from gone;

  -- Trips left with no riders and nothing notable about them.
  with gone as (
    delete from daily_trips t
    where t.date < cutoff
      and not trip_is_notable(t.id)
      and not exists (select 1 from student_trip_status s where s.trip_id = t.id)
    returning 1
  ) select count(*) into d_trips from gone;

  -- GPS breadcrumbs. Pure telemetry, and by far the biggest table when tracking
  -- is on — one row every few seconds per van. Nothing references them.
  with gone as (
    delete from vehicle_locations where recorded_at < cutoff returning 1
  ) select count(*) into d_locs from gone;

  -- Notifications the person has already read.
  with gone as (
    delete from notifications
    where read_at is not null and created_at < cutoff
    returning 1
  ) select count(*) into d_notifs from gone;

  -- Routine status transitions. An override always carries a reason (the app
  -- demands one, blueprint §2.1), so `reason is not null` is exactly the set
  -- worth keeping — and it is kept forever.
  with gone as (
    delete from audit_logs
    where changed_at < cutoff
      and reason is null
      and not exists (
        select 1 from student_trip_status s where s.id = audit_logs.entity_id
      )
    returning 1
  ) select count(*) into d_audit from gone;

  return jsonb_build_object(
    'cutoff', cutoff,
    'retention_weeks', keep_weeks,
    'deleted', jsonb_build_object(
      'student_trip_status', d_status,
      'daily_trips', d_trips,
      'vehicle_locations', d_locs,
      'notifications', d_notifs,
      'audit_logs', d_audit
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- The weekly job: archive last week, tell everyone, then purge.
--
-- Order matters and is not negotiable. Reports first, always.
-- ---------------------------------------------------------------------------

create or replace function run_weekly_maintenance()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  reports int;
  purged jsonb;
begin
  reports := generate_weekly_reports();   -- last completed week
  purged  := purge_routine_data();

  -- Leave a trail, so an admin can see the job ran and what it did.
  insert into audit_logs (entity_type, action, new_value, reason, changed_by)
  values (
    'system', 'weekly_maintenance',
    jsonb_build_object('reports', reports) || purged,
    'Scheduled weekly archive and purge.',
    auth.uid()
  );

  return jsonb_build_object('reports_generated', reports) || purged;
end;
$$;

-- Staff can run it by hand from the portal; cron runs it as the table owner.
grant execute on function run_weekly_maintenance() to authenticated;
grant execute on function generate_weekly_reports(date) to authenticated;
grant execute on function purge_routine_data() to authenticated;

-- Only staff may actually trigger it, whatever the grant says.
create or replace function trigger_weekly_maintenance()
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then
    raise exception 'Only the transport office can run maintenance.';
  end if;
  return run_weekly_maintenance();
end;
$$;

grant execute on function trigger_weekly_maintenance() to authenticated;

-- ---------------------------------------------------------------------------
-- The schedule, as a switch in the admin portal.
--
-- Sundays at 03:00, via pg_cron. An admin turns it on and off from
-- Setup → Data — nobody should have to paste cron SQL into a dashboard to make
-- the system look after itself.
--
-- Everything below uses EXECUTE rather than referring to `cron.*` directly, so
-- this file still installs cleanly on a database where pg_cron has never been
-- enabled. The functions then report that plainly instead of failing to create.
-- ---------------------------------------------------------------------------

create or replace function weekly_schedule_status() returns jsonb
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

  execute $q$
    select schedule from cron.job where jobname = 'weekly-transport-maintenance'
  $q$ into sched;

  return jsonb_build_object(
    'installed', true,
    'enabled', sched is not null,
    'schedule', sched
  );
end;
$$;

create or replace function set_weekly_schedule(enable boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  installed boolean;
begin
  -- Scheduling a job that deletes data is an administrator's decision.
  if not is_admin() then
    raise exception 'Only an administrator can change the maintenance schedule.';
  end if;

  select exists (select 1 from pg_extension where extname = 'pg_cron') into installed;
  if not installed then
    raise exception 'pg_cron is not enabled on this project. Dashboard → Database → Extensions → enable pg_cron, then try again.';
  end if;

  if enable then
    -- cron.schedule() upserts by job name, so turning it on twice is harmless.
    execute $q$
      select cron.schedule(
        'weekly-transport-maintenance',
        '0 3 * * 0',
        'select run_weekly_maintenance()'
      )
    $q$;
  else
    -- Idempotent: unscheduling a job that is not there raises, so check first.
    if exists (select 1 from pg_extension where extname = 'pg_cron') then
      begin
        execute $q$ select cron.unschedule('weekly-transport-maintenance') $q$;
      exception when others then
        null;  -- already gone; nothing to do
      end;
    end if;
  end if;

  insert into audit_logs (entity_type, action, new_value, reason, changed_by)
  values (
    'system',
    case when enable then 'weekly_schedule_enabled' else 'weekly_schedule_disabled' end,
    jsonb_build_object('enabled', enable),
    'Weekly archive and purge schedule changed from the admin portal.',
    auth.uid()
  );

  return weekly_schedule_status();
end;
$$;

grant execute on function weekly_schedule_status() to authenticated;
grant execute on function set_weekly_schedule(boolean) to authenticated;

-- If you would rather do it by hand, this is the same thing:
--
--   select cron.schedule(
--     'weekly-transport-maintenance',
--     '0 3 * * 0',
--     $$ select run_weekly_maintenance() $$
--   );
--
--   select cron.unschedule('weekly-transport-maintenance');
