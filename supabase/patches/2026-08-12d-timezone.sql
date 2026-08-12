-- ===========================================================================
-- Patch 2026-08-12 (fourth) — the vans are not in UTC
--
-- `planned_arrival` and `planned_departure` are `time` columns: wall-clock times
-- for the operation, with no zone attached. Every comparison against them
-- resolved in the DATABASE's timezone, which on Supabase is UTC.
--
-- For an operation running in New York that is a FOUR HOUR error, and it hit
-- four things at once:
--
--   * the watchdog decided every morning route was hours overdue before the day
--     started, and never noticed a genuinely late afternoon one;
--   * "your van is due in 15 minutes" fired overnight;
--   * the change-request cutoff was judged against the wrong clock;
--   * the check-in window opened and closed at the wrong times.
--
-- Fixed by putting the operation's timezone on `organization` and routing every
-- comparison through local_ts(). Set it to a REGION name — 'America/New_York'
-- follows daylight saving; 'EST' is a fixed -05:00 and is wrong all summer.
--
-- Also widens both cron schedules. They were '6-19 * * 1-5', which is in the
-- DATABASE's timezone: on a UTC project that is 02:00-15:59 in New York, missing
-- the afternoon run entirely. They now run all day, which costs nothing — the
-- watchdog is naturally silent when nothing is scheduled.
-- ===========================================================================

alter table organization
  add column if not exists time_zone text not null default 'UTC';

-- >>> CHANGE THIS LINE if your vans do not run on US Eastern. <<<
update organization set time_zone = 'America/New_York' where id = 1;

-- Reject a zone Postgres does not know, now rather than at 3am.
do $do$
begin
  perform now() at time zone (select time_zone from organization where id = 1);
exception when others then
  raise exception 'organization.time_zone is not a timezone Postgres recognises. Use a region name like America/New_York.';
end
$do$;

create or replace function org_tz() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(btrim(time_zone), ''), 'UTC') from organization where id = 1;
$$;

create or replace function local_ts(on_date date, at_time time) returns timestamptz
language sql stable security definer set search_path = public as $$
  select (on_date + at_time) at time zone org_tz();
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
        or now() between local_ts(t.date, rs.planned_arrival)
                         - make_interval(mins => o.checkin_window_min)
                     and local_ts(t.date, rs.planned_arrival) + interval '30 min'
      )
  );
$$;

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
  cutoff := local_ts(new.date, case
    when new.kind = 'absent' then org.morning_cutoff
    else org.afternoon_cutoff
  end);

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
    and now() > local_ts(t.date, fs.planned_departure)
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
    and now() > local_ts(t.date, rs.planned_arrival)
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
             local_ts(t.date, rs.planned_arrival)
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
           local_ts(t.date, rs.planned_arrival) + make_interval(mins => total) as due_at
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
           local_ts(t.date, rs.planned_arrival) + make_interval(mins => total)
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
        -- Every five minutes, always. The old '6-19 * * 1-5' window was in the
        -- DATABASE's timezone, so on a UTC project it covered 02:00–15:59 in New
        -- York and missed the afternoon run entirely. The function is naturally
        -- quiet outside operating hours anyway — nothing is overdue at 3am
        -- because nothing is scheduled — so the window bought noise reduction
        -- that was never needed and a timezone bug that was.
        '*/5 * * * *',
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
      select cron.schedule('arrival-alerts', '*/2 * * * *', 'select send_arrival_alerts()')
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

-- ---------------------------------------------------------------------------
-- If the cron jobs were already scheduled, re-issue them so they pick up the
-- widened window. cron.schedule() upserts by job name, so this is safe.
-- Skipped silently when pg_cron is not installed.
-- ---------------------------------------------------------------------------
do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'transport-watchdog') then
      perform cron.schedule('transport-watchdog', '*/5 * * * *', 'select transport_watchdog()');
    end if;
    if exists (select 1 from cron.job where jobname = 'arrival-alerts') then
      perform cron.schedule('arrival-alerts', '*/2 * * * *', 'select send_arrival_alerts()');
    end if;
  end if;
end
$do$;
