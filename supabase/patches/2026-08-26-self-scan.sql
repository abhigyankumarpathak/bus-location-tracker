-- ---------------------------------------------------------------------------
-- Self-scan boarding: the STUDENT scans the VAN.
--
-- This inverts the scan model. Until now `attendance_mode = 'scan'` meant the
-- driver pointed their camera at a code on each student's phone -- one driver
-- action per child, which is faster than tapping but not fewer decisions. The
-- operator's requirement is to minimise what the driver touches at all, so the
-- code now lives ON THE VAN (laminated, by the door) and the students scan it.
--
-- WHAT THAT COSTS, STATED PLAINLY
--
-- A self-scan is not a driver observation. Blueprint §2.1 makes the driver the
-- official record precisely because a child can scan from the pavement and then
-- not get on. Three things narrow that hole, and none of them closes it:
--
--   1. The printed code identifies the VEHICLE, not the trip. On its own it
--      says nothing and does nothing. Every check below happens server-side
--      against the trip that vehicle is running RIGHT NOW.
--   2. It only works while the van is actually AT that student's stop --
--      arrived, not yet departed. A photograph of the code is worthless at home,
--      on another day, or on a van the student does not ride.
--   3. The driver still confirms the departure, and the app still refuses to
--      leave a stop while a rostered student there has no outcome. That
--      confirmation is what ratifies the scans, and it is the reason this is a
--      faster path to the same record rather than a weaker record.
--
-- The residual risk is a student scanning from within range while the van is at
-- their stop, and then not boarding. The departure confirmation is what catches
-- it: the driver is looking at a count.
--
-- WHY NOT REUSE device_key
--
-- `vehicle_devices.device_key` is the GPS tracker credential, and
-- supabase/functions/ingest-location accepts it WITHOUT a user JWT. Printing it
-- on a card inside the van would hand every rider the ability to forge the
-- van's position. `board_code` is a separate secret with separate powers: it can
-- board its holder onto a van that is standing in front of them, and nothing
-- else.
-- ---------------------------------------------------------------------------

-- The printed code's secret. Same table as device_key because it is the same
-- kind of thing -- a per-vehicle credential that `vehicles` (readable by every
-- signed-in user) must never carry.
alter table vehicle_devices
  add column if not exists board_code text unique
  not null default encode(gen_random_bytes(12), 'hex');


-- ---------------------------------------------------------------------------
-- What staff need to print the cards.
--
-- vehicle_devices is admin-read-only, and deliberately: it holds the GPS
-- credential. But printing boarding cards is a coordinator's job, so this hands
-- back the boarding secret ONLY -- never device_key -- to staff.
-- ---------------------------------------------------------------------------
create or replace function vehicle_board_codes()
returns table (vehicle_id uuid, label text, plate text, board_code text)
language sql stable security definer set search_path = public as $$
  select v.id, v.label, v.plate, vd.board_code
  from vehicles v
  join vehicle_devices vd on vd.vehicle_id = v.id
  where is_staff() and v.active
  order by v.label;
$$;

revoke execute on function vehicle_board_codes() from public, anon;
grant execute on function vehicle_board_codes() to authenticated;


-- A printed card can be photographed, and eventually one will be. Rotating is
-- how that gets fixed, and it has to be reachable without a database console at
-- the moment somebody notices. Admin only: it invalidates every card in a van.
create or replace function rotate_board_code(target uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  fresh text := encode(gen_random_bytes(12), 'hex');
begin
  if not is_admin() then
    raise exception 'Only an administrator can reissue a vehicle boarding code.';
  end if;

  update vehicle_devices set board_code = fresh where vehicle_id = target;
  if not found then
    raise exception 'No such vehicle.';
  end if;

  insert into audit_logs (entity_type, entity_id, action, reason, changed_by)
  values ('vehicles', target, 'board_code_rotated',
          'Boarding code reissued; printed cards for this vehicle no longer work.',
          auth.uid());

  return fresh;
end;
$$;

revoke execute on function rotate_board_code(uuid) from public, anon;
grant execute on function rotate_board_code(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- The scan itself.
--
-- Called by the STUDENT, from the student app, with the payload off the card in
-- the van. Security definer because it has to read the roster of a trip the
-- caller can only see their own row of, and because the write it makes is one
-- the student's own RLS policy forbids ("students check in only" caps them at
-- `waiting`). That policy is not being loosened -- it still means a student
-- cannot mark themselves boarded by calling PostgREST directly. This function is
-- the only door, and every check below is the lock.
--
-- Returns a jsonb verdict rather than raising, because every outcome here is
-- something a fourteen-year-old standing in the rain has to be able to act on:
-- which van they should be on, whether to wait, or whether to talk to the
-- driver. A Postgres exception is not that.
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

  -- 1. Which van is this card in?
  select vd.vehicle_id, v.label into van_id, van_label
  from vehicle_devices vd
  join vehicles v on v.id = vd.vehicle_id
  where vd.board_code = btrim(code);

  if van_id is null then
    return jsonb_build_object(
      'ok', false, 'tone', 'danger', 'reason', 'unknown_code',
      'message', 'That code is not one of ours. Ask the driver to board you by name.');
  end if;

  -- 2. Is it running a route right now? The card is inert otherwise, which is
  --    what makes a photograph of it worthless outside a live run.
  select t.* into trip
  from daily_trips t
  where t.vehicle_id = van_id
    and t.date = current_date
    and t.status = 'active'
  order by t.started_at desc nulls last
  limit 1;

  if trip.id is null then
    return jsonb_build_object(
      'ok', false, 'tone', 'warn', 'reason', 'no_active_trip',
      'message', van_label || ' has not started its route yet. Scan as you get on.');
  end if;

  -- 3. Is the caller actually on this van today?
  select sts.* into rider
  from student_trip_status sts
  where sts.trip_id = trip.id and sts.student_id = me;

  if rider.id is null then
    -- The wrong-van case, and the one worth answering properly. A child holding
    -- the right app at the wrong door should be TOLD where to go, not given an
    -- error -- this is the same answer identify_boarding_code() gives a driver.
    select rt.name as route_name, p.full_name as driver_name
      into other
    from student_trip_status sts
    join daily_trips t       on t.id = sts.trip_id
    join route_templates rt  on rt.id = t.route_id
    left join profiles p     on p.id = t.driver_id
    where sts.student_id = me
      and t.date = current_date
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

  -- 4. Already aboard. Not an error -- a second scan is the most likely mistap
  --    there is, and it must not read like a failure.
  if rider.status in ('boarded', 'in_transit') then
    return jsonb_build_object(
      'ok', true, 'tone', 'warn', 'reason', 'already_aboard',
      'message', 'You are already marked on board. Nothing more to do.');
  end if;

  -- 5. The record says they are not travelling. Scanning must not silently
  --    contradict an absence the office is holding a request for -- that is
  --    exactly the case C4 built "Boarding anyway" for, and it needs a driver
  --    and a note.
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

  -- 6. THE CHECK THAT MATTERS. The van has to be standing at this student's own
  --    stop. Without it the printed code boards anyone, anywhere, for the whole
  --    length of the run -- which is the difference between a faster boarding
  --    and a self-service attendance system.
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

  -- 7. Board them. `updated_by` is the student, which is how
  --    notify_on_rider_status() knows to say "scanned aboard" rather than
  --    claiming the driver confirmed it -- they have not, yet. The departure
  --    confirmation is where that happens.
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

revoke execute on function board_by_vehicle_code(text) from public, anon;
grant execute on function board_by_vehicle_code(text) to authenticated;


-- ---------------------------------------------------------------------------
-- Say who actually confirmed it.
--
-- The body read "Confirmed by the driver at 7:42 AM" for every boarding. With
-- self-scan that is not true at the moment it is sent -- the student scanned,
-- and the driver ratifies it at departure. Telling a parent their child was
-- driver-confirmed when nobody has looked up yet is the kind of small lie this
-- app cannot afford, because the whole product is a custody record.
--
-- Everything else in this function is unchanged.
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
  self_scanned boolean := new.updated_by is not null
                          and new.updated_by = new.student_id;
begin
  if new.status = old.status then
    return new;
  end if;

  select full_name into student_name from profiles where id = new.student_id;
  student_name := coalesce(nullif(student_name, ''), 'The student');

  case new.status
    when 'waiting' then
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
        body  := case
                   when self_scanned then
                     'Scanned aboard at ' || when_txt
                     || '. The driver confirms the count before the van leaves.'
                   else
                     'Confirmed by the driver at ' || when_txt || '.'
                 end;
        select array_agg(parent_id) into audience from guardian_links
        where student_id = new.student_id and status = 'accepted';
      end if;

    when 'dropped_off' then
      title := student_name || ' was dropped off safely';
      body  := 'Confirmed by the driver at ' || when_txt || '.';
      select array_agg(parent_id) into audience from guardian_links
      where student_id = new.student_id and status = 'accepted';

    when 'no_show' then
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
