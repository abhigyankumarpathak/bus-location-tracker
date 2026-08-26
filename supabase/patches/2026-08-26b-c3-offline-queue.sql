-- ---------------------------------------------------------------------------
-- C3, the server half: a queued write is a record of WHEN IT HAPPENED.
--
-- The offline queue lives on the driver's phone (src/lib/outbox.ts). This is the
-- part the remediation plan asks for in its third bullet, and it is the part that
-- decides whether the queue produces a true record or a plausible-looking lie:
--
--   > Server takes the client's timestamp, not now(). Mostly already true --
--   > board_time, dropoff_time, arrived_at, departed_at and updated_at are all
--   > client-supplied today. AUDIT AND NOTIFICATION TRIGGERS NEED TO RESPECT IT
--   > TOO, or a queued boarding will be logged at flush time.
--
-- Concretely, before this patch: a driver boards Priya at 07:42 in a dead spot.
-- The van reaches signal at 07:55. Her mother is told "Confirmed by the driver at
-- 7:55 AM" and audit_logs records 07:55. Both are wrong, and the audit log is the
-- thing a dispute about a child gets settled with.
--
-- TWO CHANGES, AND THE SECOND MATTERS AS MUCH AS THE FIRST.
--
--   1. The event time is the CLIENT's, not now().
--   2. When those differ, SAY SO. A parent reading "boarded at 7:42" on a phone
--      that buzzed at 7:55 has been handed a thirteen-minute gap with no
--      explanation, and the explanation is reassuring: the van had no signal, not
--      nobody noticed. Silence would trade one wrong impression for another.
--
-- WHY updated_at IS NOT TRUSTED BLINDLY. It is the obvious event time and it is
-- wrong about a third of the time: on an UPDATE that does not include the column
-- in its SET list, `new.updated_at` is the PREVIOUS write's value, not this
-- one's. The student check-in path is exactly that. So each status takes its own
-- purpose-built timestamp first, and updated_at is only believed when this write
-- actually moved it.
-- ---------------------------------------------------------------------------

-- When the thing being recorded actually happened, as opposed to when Postgres
-- heard about it. One definition, used by both the audit log and the
-- notification, because they are describing the same event and must not
-- disagree about its time.
create or replace function rider_event_time(
  new_row student_trip_status,
  old_row student_trip_status
) returns timestamptz
language sql stable set search_path = public as $$
  select coalesce(
    case new_row.status
      when 'boarded'     then new_row.board_time
      when 'dropped_off' then new_row.dropoff_time
      when 'waiting'     then new_row.check_in_time
      else null
    end,
    -- Only when THIS write moved it. Otherwise it is the last write's clock.
    case when new_row.updated_at is distinct from old_row.updated_at
         then new_row.updated_at end,
    now()
  );
$$;

revoke execute on function rider_event_time(student_trip_status, student_trip_status)
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- The audit log records when it happened, and separately when we heard.
--
-- This is the file a dispute gets settled from. "The van left her behind at
-- 07:42" versus "the record says 07:55" is exactly the argument it exists to
-- prevent, so the recorded time has to be the driver's, and the delay has to be
-- visible rather than smoothed away.
-- ---------------------------------------------------------------------------
create or replace function log_rider_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  evt timestamptz := rider_event_time(new, old);
begin
  if new.status is distinct from old.status then
    insert into audit_logs (
      entity_type, entity_id, action, old_value, new_value, reason, changed_by, changed_at
    )
    values (
      'student_trip_status', new.id, 'status_change',
      jsonb_build_object('status', old.status),
      jsonb_build_object('status', new.status)
        -- Only when they differ enough to matter. Stamping every routine online
        -- write with a received_at equal to its changed_at is noise in the one
        -- file that has to stay readable.
        || case
             when now() - evt > interval '2 minutes'
               then jsonb_build_object('received_at', now(), 'queued_offline', true)
             else '{}'::jsonb
           end,
      new.note,
      auth.uid(),
      evt
    );
  end if;
  return new;
end;
$$;


-- ---------------------------------------------------------------------------
-- Notifications quote the driver's clock, and admit when they are late.
--
-- Carries the self-scan wording from 2026-08-26-self-scan.sql forward: this
-- function is replaced wholesale, so both changes have to be in it.
-- ---------------------------------------------------------------------------
create or replace function notify_on_rider_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  student_name text;
  evt timestamptz := rider_event_time(new, old);
  when_txt text := to_char(evt, 'HH12:MI AM');
  late boolean := now() - evt > interval '2 minutes';
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

  -- Explain the gap rather than leaving a parent to invent one. A message that
  -- says 7:42 arriving at 7:55 reads as a system nobody is watching; the same
  -- message saying why reads as a van in a dead spot, which is what happened.
  if late then
    body := body || ' (Reported at ' || to_char(now(), 'HH12:MI AM')
            || ' — the van had no signal at the time.)';
  end if;

  if audience is not null then
    insert into notifications (user_id, title, body, kind)
    select distinct u, title, body, kind_txt
    from unnest(audience) as u
    where u is not null;
  end if;

  return new;
end;
$$;


-- ---------------------------------------------------------------------------
-- The same honesty on "the van has left your hub" (S7).
--
-- This one already quoted new.departed_at rather than now(), so the TIME was
-- right. What was missing is the explanation when it arrives thirteen minutes
-- afterwards, which for the parent's most-asked question is the difference
-- between a useful alert and a confusing one.
-- ---------------------------------------------------------------------------
create or replace function notify_on_stop_departure() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  stop_name text;
  late_txt text := '';
begin
  if new.departed_at is null then return new; end if;
  if tg_op = 'UPDATE' and old.departed_at is not null then return new; end if;

  select coalesce(h.name, s.name, 'the stop') into stop_name
  from route_stops rs
  left join hubs    h on h.id = rs.hub_id
  left join schools s on s.id = rs.school_id
  where rs.id = new.stop_id;

  if now() - new.departed_at > interval '2 minutes' then
    late_txt := ' (Reported at ' || to_char(now(), 'HH12:MI AM')
                || ' — the van had no signal at the time.)';
  end if;

  -- Grouped per guardian (N1): a parent with two children on the same van gets
  -- one message naming both, not two pushes a second apart.
  insert into notifications (user_id, title, body, kind)
  select gl.parent_id,
         string_agg(distinct coalesce(nullif(pr.full_name, ''), 'Your child'), ' and ')
           -- Past simple reads correctly for one child or several; "has left"
           -- does not once the names are collapsed.
           || ' left ' || stop_name,
         'The van pulled away at ' || to_char(new.departed_at, 'HH12:MI AM') || '.' || late_txt,
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
