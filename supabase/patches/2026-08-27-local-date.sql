-- ===========================================================================
-- Patch 2026-08-27 — the vans are not in UTC, part two: the DATE
--
-- Patch 4 (2026-08-12d) fixed every wall-clock TIME by routing it through
-- local_ts(). It left the DATE alone, and the date had the same bug.
--
-- `current_date` is the database's date, and on Supabase the database is UTC.
-- For an operation running in New York that means the day rolls over at 8pm
-- local — while an afternoon route is still running. What that looked like:
--
--   * every trip disappeared from the coordinator dashboard and from every
--     driver's "Today's trips" at 8pm, because both ask for today and today had
--     silently become tomorrow;
--   * nothing came back until something called ensure_todays_trips(), which
--     then generated TOMORROW's trips and marked them as the day's work;
--   * a change request submitted at 9pm was judged against the wrong day's
--     cutoff;
--   * the watchdog, the arrival alerts, the self-scan boarding check and the
--     "riders read their driver" policy all went looking on the wrong date for
--     four hours every evening.
--
-- The fix is the same shape as patch 4: one function that knows what day it is
-- where the vans are, and no bare current_date left anywhere.
--
--   today_local()  ->  (now() at time zone org_tz())::date
--
-- It reads organization.time_zone, so the zone stays in one place and the app
-- can change it without a migration. Set that column correctly BEFORE running
-- this, or the operation's day is still UTC's day:
--
--   update organization set time_zone = 'America/New_York' where id = 1;
--
-- Safe to re-run. Everything here is create-or-replace or alter.
-- ===========================================================================

-- The clock, one level up from local_ts(). Stable, so a sweep that straddles
-- local midnight compares every row against the same date rather than half
-- against one day and half against the next.

create or replace function today_local() returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone org_tz())::date;
$$;

-- ---------------------------------------------------------------------------
-- Is it a sensible time for this student to say "I am at the hub"?
-- ---------------------------------------------------------------------------
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
      and t.date = today_local()
      and (
        rs.planned_arrival is null
        or now() between local_ts(t.date, rs.planned_arrival)
                         - make_interval(mins => o.checkin_window_min)
                     and local_ts(t.date, rs.planned_arrival) + interval '30 min'
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- Is this student on one of the caller's trips today?
-- ---------------------------------------------------------------------------
create or replace function drives_student(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_active() and exists (
    select 1
    from student_trip_status sts
    join daily_trips t on t.id = sts.trip_id
    where sts.student_id = target
      and t.driver_id = auth.uid()
      and t.date = today_local()
  );
$$;

-- ---------------------------------------------------------------------------
-- The one that generates the day. `target_date` now defaults to the
-- operation's day, which is what ensure_todays_trips() passes anyway.
-- ---------------------------------------------------------------------------
create or replace function ensure_daily_trips(target_date date default today_local())
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

-- ---------------------------------------------------------------------------
-- What the apps call on open.
-- ---------------------------------------------------------------------------
create or replace function ensure_todays_trips() returns int
language plpgsql security definer set search_path = public as $$
begin
  if not is_active() then
    raise exception 'Your account is not active.';
  end if;
  return ensure_daily_trips(today_local());
end;
$$;

-- ---------------------------------------------------------------------------
-- The cutoff: judged against the operation's day, not the database's.
-- ---------------------------------------------------------------------------
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
    elsif now() <= cutoff or new.date > today_local() then
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

-- ---------------------------------------------------------------------------
-- "Route 2 is running late" -- which trips count as still ahead.
-- ---------------------------------------------------------------------------
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
        and t.route_id = new.route_id and t.date >= today_local()
      union
      select gl.parent_id from student_trip_status sts
      join daily_trips t on t.id = sts.trip_id
      join guardian_links gl on gl.student_id = sts.student_id and gl.status = 'accepted'
      where new.student_id is null and new.route_id is not null
        and t.route_id = new.route_id and t.date >= today_local()
      union
      select t.driver_id from daily_trips t
      where new.student_id is null and new.route_id is not null
        and t.route_id = new.route_id and t.date >= today_local()
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

-- ---------------------------------------------------------------------------
-- The watchdog. Five separate date comparisons, all of them wrong for
-- four hours every evening.
-- ---------------------------------------------------------------------------
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
  where t.date = today_local()
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
  where t.date = today_local()
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
  where t.date = today_local()
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
  where t.date = today_local()
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
  where t.date = today_local()
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

-- ---------------------------------------------------------------------------
-- The 15-and-5-minute alerts.
-- ---------------------------------------------------------------------------
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
      where t.date = today_local()
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

-- ---------------------------------------------------------------------------
-- The old driver-scans-student path.
-- ---------------------------------------------------------------------------
create or replace function identify_boarding_code(code text)
-- `route_kind` rather than `route_type`: an OUT column sharing a name with the
-- enum type is legal but becomes a plpgsql variable shadowing that type inside
-- the body, which is a trap for whoever edits this next.
returns table (
  student_name text,
  route_name   text,
  route_kind   route_type,
  driver_name  text,
  trip_date    date,
  is_today     boolean
)
language plpgsql security definer set search_path = public as $$
begin
  if not (is_staff() or my_role() = 'driver') then
    raise exception 'Only a driver or the transport office can identify a boarding code.';
  end if;

  return query
  select
    coalesce(nullif(sp.full_name, ''), 'A student'),
    rt.name,
    rt.type,
    coalesce(nullif(dp.full_name, ''), 'Not assigned'),
    t.date,
    t.date = today_local()
  from student_trip_status sts
  join daily_trips t      on t.id = sts.trip_id
  join route_templates rt on rt.id = t.route_id
  join profiles sp        on sp.id = sts.student_id
  left join profiles dp   on dp.id = t.driver_id
  where sts.boarding_code = code
  limit 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- The self-scan. A student boarding at 8:15pm was checked against
-- tomorrow's trip, found nothing, and was told they were not riding today.
-- ---------------------------------------------------------------------------
create or replace function board_by_vehicle_code(code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me          uuid := auth.uid();
  van_id      uuid;
  van_label   text;
  trip        daily_trips;
  rider       student_trip_status;
  prog        trip_stop_progress;
  origin_stop uuid;
  other       record;
begin
  if me is null then
    return jsonb_build_object(
      'ok', false, 'tone', 'danger', 'reason', 'signed_out',
      'message', 'Sign in first, then scan.');
  end if;

  if not is_active() then
    return jsonb_build_object(
      'ok', false, 'tone', 'danger', 'reason', 'inactive',
      'message', 'This account is not active. Talk to the transport office.');
  end if;

  select vd.vehicle_id, v.label into van_id, van_label
  from vehicle_devices vd
  join vehicles v on v.id = vd.vehicle_id
  where vd.board_code = btrim(code);

  if van_id is null then
    return jsonb_build_object(
      'ok', false, 'tone', 'danger', 'reason', 'unknown_code',
      'message', 'That code is not one of ours. Ask the driver to board you by name.');
  end if;

  select t.* into trip
  from daily_trips t
  where t.vehicle_id = van_id
    and t.date = today_local()
    and t.status = 'active'
  order by t.started_at desc nulls last
  limit 1;

  if trip.id is null then
    return jsonb_build_object(
      'ok', false, 'tone', 'warn', 'reason', 'no_active_trip',
      'message', van_label || ' has not started its route yet. Scan as you get on.');
  end if;

  select sts.* into rider
  from student_trip_status sts
  where sts.trip_id = trip.id and sts.student_id = me;

  if rider.id is null then
    -- The wrong-van case, and the one worth answering properly. A child holding
    -- the right app at the wrong door should be TOLD where to go, not handed an
    -- error.
    select rt.name as route_name, p.full_name as driver_name
      into other
    from student_trip_status sts
    join daily_trips t       on t.id = sts.trip_id
    join route_templates rt  on rt.id = t.route_id
    left join profiles p     on p.id = t.driver_id
    where sts.student_id = me
      and t.date = today_local()
      and t.status in ('scheduled', 'active')
    order by t.started_at nulls last
    limit 1;

    if other.route_name is not null then
      return jsonb_build_object(
        'ok', false, 'tone', 'danger', 'reason', 'wrong_van',
        'message', 'This is ' || van_label || ', and you are not on it today. You ride '
                   || other.route_name
                   || coalesce(' with ' || other.driver_name, '')
                   || '. Do not get on -- find your van or tell the driver.');
    end if;

    return jsonb_build_object(
      'ok', false, 'tone', 'danger', 'reason', 'not_riding',
      'message', 'You are not down to ride today. Talk to the driver before you get on.');
  end if;

  -- A second scan is the most likely mistap there is. It must not read as a
  -- failure.
  if rider.status in ('boarded', 'in_transit') then
    return jsonb_build_object(
      'ok', true, 'tone', 'warn', 'reason', 'already_aboard',
      'message', 'You are already marked on board. Nothing more to do.');
  end if;

  -- Scanning must not silently contradict an absence the office is holding a
  -- request for. That is the case C4 built "Boarding anyway" for, and it needs a
  -- driver and a note.
  if rider.status in ('absent', 'parent_pickup', 'no_show') then
    return jsonb_build_object(
      'ok', false, 'tone', 'danger', 'reason', 'marked_away',
      'message', 'You are recorded as not travelling today, so scanning will not board you. '
                 || 'Speak to the driver -- they can still take you.');
  end if;

  if rider.status <> 'scheduled' and rider.status <> 'waiting' then
    return jsonb_build_object(
      'ok', false, 'tone', 'warn', 'reason', 'not_boardable',
      'message', 'Your ride is already recorded as '
                 || replace(rider.status::text, '_', ' ') || '. See the driver.');
  end if;

  -- THE CHECK THAT MATTERS. Without it the printed card boards anyone, anywhere,
  -- for the whole length of the run.
  select tsp.* into prog
  from trip_stop_progress tsp
  where tsp.trip_id = trip.id and tsp.stop_id = rider.pickup_stop_id;

  -- The origin is the one stop a driver never marks an arrival at: the van
  -- starts there. For an afternoon run that is the school, where most of the
  -- roster boards, so treating "no arrival recorded" as "not here yet" would
  -- break every afternoon scan.
  select rs.id into origin_stop
  from route_stops rs
  where rs.route_id = trip.route_id
  order by rs.seq
  limit 1;

  if prog.departed_at is not null then
    return jsonb_build_object(
      'ok', false, 'tone', 'danger', 'reason', 'van_departed',
      'message', 'The van has already left your stop. Do not get on -- tell the driver.');
  end if;

  if prog.arrived_at is null and rider.pickup_stop_id is distinct from origin_stop then
    return jsonb_build_object(
      'ok', false, 'tone', 'warn', 'reason', 'van_not_here',
      'message', 'The van has not reached your stop yet. Scan the code as you get on.');
  end if;

  -- `updated_by` is the student, which is how notify_on_rider_status() knows to
  -- say "scanned aboard" rather than claiming the driver confirmed it -- they
  -- have not, yet. The departure confirmation is where that happens.
  update student_trip_status
  set status     = 'boarded',
      board_time = now(),
      updated_by = me,
      updated_at = now()
  where id = rider.id;

  return jsonb_build_object(
    'ok', true, 'tone', 'success', 'reason', 'boarded',
    'vehicle', van_label,
    'message', 'You are on board ' || van_label || '. Your family has been told.');
end;
$$;

-- ---------------------------------------------------------------------------
-- "Whose van is this child on?"
-- ---------------------------------------------------------------------------
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
  where t.date = today_local()
    and p.full_name ilike '%' || btrim(search) || '%'
  order by (t.driver_id = auth.uid()) desc, p.full_name
  limit 10;
end;
$$;

-- ---------------------------------------------------------------------------
-- The column default. Every insert in this schema passes an explicit date, so
-- this only catches a trip created by hand in the SQL editor -- which is
-- exactly the moment nobody is thinking about timezones.
-- ---------------------------------------------------------------------------
alter table daily_trips alter column date set default today_local();

-- ---------------------------------------------------------------------------
-- The two policies that also asked the wrong day. A rider could not read their
-- driver's name, and could not read the van's position, for the hours between
-- the UTC rollover and local midnight -- the evening run, in other words.
-- ---------------------------------------------------------------------------
alter policy "riders read their driver" on profiles using (
  exists (
    select 1
    from daily_trips t
    join student_trip_status sts on sts.trip_id = t.id
    where t.driver_id = profiles.id
      and t.date = today_local()
      and (sts.student_id = auth.uid() or is_guardian_of(sts.student_id))
  )
);

alter policy "read locations" on vehicle_locations using (
  is_staff() or (is_active() and exists (
    select 1 from daily_trips t
    where t.vehicle_id = vehicle_locations.vehicle_id
      and t.date = today_local()
      and (
        t.driver_id = auth.uid()
        or exists (
          select 1 from student_trip_status sts
          where sts.trip_id = t.id
            and (sts.student_id = auth.uid() or is_guardian_of(sts.student_id))
        )
      )
  ))
);

-- ---------------------------------------------------------------------------
-- Generate the local day's trips now, rather than waiting for somebody to open
-- the app. If the UTC rollover already happened this evening, the trips that
-- exist are dated tomorrow and today's are missing -- this is what puts the
-- route back on the board.
-- ---------------------------------------------------------------------------
select ensure_daily_trips(today_local()) as trips_created;

-- What day does the operation think it is now? These two should differ only
-- during the hours the old bug was live.
select time_zone, today_local() as operating_day, current_date as database_day
from organization where id = 1;
