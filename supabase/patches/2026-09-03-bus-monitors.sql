-- ---------------------------------------------------------------------------
-- Bus monitors: the students who account for the students without phones.
--
-- Self-scan assumes a phone. Some riders do not have one, and until now they
-- could only ever appear in the register as MISSING -- indistinguishable from a
-- child who should be there and is not, which is the one signal the whole screen
-- exists to protect. Ten unscannable students would bury one real absence every
-- single evening, and a register that cries wolf nightly is a register nobody
-- reads.
--
-- So a handful of students are made MONITORS. The phone-less riders are divided
-- between them, and each monitor confirms their own few.
--
-- THE DIVISION IS COMPUTED, NOT STORED. Both sets change -- a student gets a
-- phone, a monitor leaves -- and a stored assignment would rot silently into
-- "this child is on nobody's list", which is the exact failure being fixed.
-- Ordering both sets by name and dealing round-robin re-balances itself the
-- moment either list changes, and is stable for as long as neither does.
--
-- WHAT A MONITOR'S CONFIRMATION IS. A student saying another student is on the
-- bus. That is weaker than a driver's confirmation and it is recorded as such:
-- `source = 'monitor'` with the monitor's id in `marked_by`, never merged with a
-- scan. In attendance-only mode there is no driver to do better, and a named
-- teenager who was standing there beats nothing at all -- but the record must
-- not pretend it is more than it is.
-- ---------------------------------------------------------------------------

alter table students
  -- Cannot self-scan. Not a judgement about the student, just a fact about the
  -- hardware, and the only reason the app needs to know is so somebody else is
  -- made responsible for them.
  add column if not exists has_phone boolean not null default true,
  add column if not exists is_monitor boolean not null default false;

comment on column students.has_phone is
  'False when the student cannot self-scan. Their attendance is confirmed by a bus monitor.';
comment on column students.is_monitor is
  'This student confirms the phone-less riders assigned to them.';

-- A monitor's confirmation is its own kind of record. Never a scan.
alter table attendance drop constraint if exists attendance_source_check;
alter table attendance
  add constraint attendance_source_check
  check (source in ('scan', 'staff', 'monitor'));


-- ---------------------------------------------------------------------------
-- Who is whose.
--
-- Deterministic round-robin: both lists ordered by name, student i to monitor
-- (i mod monitor_count). Returns nothing when there are no monitors, which is
-- the honest answer -- somebody has to be made responsible before anybody is.
-- ---------------------------------------------------------------------------
create or replace function monitor_assignments(on_day date default null)
returns table (
  monitor_id   uuid,
  monitor_name text,
  student_id   uuid,
  student_name text,
  present      boolean,
  marked_at    timestamptz,
  source       text
)
language sql stable security definer set search_path = public as $$
  with d as (select coalesce(on_day, today_local()) as day),
  monitors as (
    select p.id, p.full_name,
           (row_number() over (order by p.full_name, p.id)) - 1 as idx,
           count(*) over () as total
    from profiles p
    join students s on s.student_id = p.id
    where p.role = 'student' and p.status = 'active' and s.is_monitor
  ),
  -- Phone-less, and NOT expected away. A monitor asked to account for a child
  -- whose parents have already said they are not coming would either mark them
  -- wrongly present or report a false absence; neither is worth their time.
  riders as (
    select p.id, p.full_name,
           (row_number() over (order by p.full_name, p.id)) - 1 as idx
    from profiles p
    join students s on s.student_id = p.id
    cross join d
    where p.role = 'student' and p.status = 'active'
      and not s.has_phone
      and not s.is_monitor
      and not exists (
        select 1 from attendance_absence ab
        where ab.student_id = p.id
          and ab.cancelled_at is null
          and ab.on_date <= d.day
          and coalesce(ab.end_date, ab.on_date) >= d.day
      )
  )
  select m.id, m.full_name, r.id, r.full_name,
         a.id is not null, a.marked_at, a.source
  from riders r
  cross join d
  join monitors m on m.idx = r.idx % m.total
  left join attendance a on a.student_id = r.id and a.on_date = d.day
  order by m.full_name, r.full_name;
$$;

revoke execute on function monitor_assignments(date) from public, anon, authenticated;


-- What the calling monitor has to account for this evening.
create or replace function my_monitor_roster()
returns table (
  student_id   uuid,
  student_name text,
  present      boolean,
  marked_at    timestamptz,
  source       text
)
language sql stable security definer set search_path = public as $$
  select a.student_id, a.student_name, a.present, a.marked_at, a.source
  from monitor_assignments(today_local()) a
  where a.monitor_id = auth.uid() and is_active();
$$;

revoke execute on function my_monitor_roster() from public, anon;
grant execute on function my_monitor_roster() to authenticated;


-- ---------------------------------------------------------------------------
-- "Everyone without a phone is here."
--
-- Takes the list rather than a blanket flag, so a monitor can leave somebody
-- OFF. The alternative -- one button asserting everybody -- is the same mistake
-- the full app fixed with per-child exceptions before its batch drop-off: a
-- single tap covering thirty children trains the tap, and then it means nothing.
-- ---------------------------------------------------------------------------
create or replace function monitor_mark(targets uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me      uuid := auth.uid();
  mine    uuid[];
  allowed uuid[];
  marked  int := 0;
begin
  if me is null or not is_active() then
    return jsonb_build_object('ok', false, 'message', 'Sign in first.');
  end if;

  if not exists (select 1 from students where student_id = me and is_monitor) then
    return jsonb_build_object('ok', false, 'message', 'You are not a bus monitor.');
  end if;

  select array_agg(a.student_id) into mine
  from monitor_assignments(today_local()) a
  where a.monitor_id = me;

  -- A monitor may only speak for the students actually dealt to them. Anything
  -- else in the list is silently dropped rather than refused: the caller is a
  -- screen, and a stale roster is a race, not an attack.
  select array_agg(t) into allowed
  from unnest(coalesce(targets, '{}')) t
  where t = any (coalesce(mine, '{}'));

  if allowed is null then
    return jsonb_build_object('ok', true, 'marked', 0);
  end if;

  insert into attendance (student_id, on_date, source, marked_by, note)
  select t, today_local(), 'monitor', me, 'Confirmed aboard by a bus monitor.'
  from unnest(allowed) t
  on conflict (student_id, on_date) do nothing;

  get diagnostics marked = row_count;
  return jsonb_build_object('ok', true, 'marked', marked);
end;
$$;

revoke execute on function monitor_mark(uuid[]) from public, anon;
grant execute on function monitor_mark(uuid[]) to authenticated;


-- Staff view: everyone, with whether they can scan and who answers for them.
create or replace function attendance_roll()
returns table (
  student_id uuid,
  full_name  text,
  has_phone  boolean,
  is_monitor boolean,
  answers_to text
)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, s.has_phone, s.is_monitor, m.monitor_name
  from profiles p
  join students s on s.student_id = p.id
  left join lateral (
    select a.monitor_name from monitor_assignments(today_local()) a
    where a.student_id = p.id limit 1
  ) m on true
  where is_staff() and p.role = 'student' and p.status = 'active'
  order by s.is_monitor desc, s.has_phone, p.full_name;
$$;

revoke execute on function attendance_roll() from public, anon;
grant execute on function attendance_roll() to authenticated;


-- Staff set both flags. Students do not choose whether they own a phone as far
-- as this app is concerned, and certainly do not appoint themselves monitors.
create or replace function set_student_flags(
  target      uuid,
  phone       boolean default null,
  monitor     boolean default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then
    raise exception 'Only the office can change this.';
  end if;

  update students
  set has_phone  = coalesce(phone, has_phone),
      is_monitor = coalesce(monitor, is_monitor)
  where student_id = target;

  if not found then
    raise exception 'That student has no record to update.';
  end if;

  insert into audit_logs (entity_type, entity_id, action, new_value, changed_by)
  values ('students', target, 'flags_changed',
          jsonb_build_object('has_phone', phone, 'is_monitor', monitor), auth.uid());

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function set_student_flags(uuid, boolean, boolean) from public, anon;
grant execute on function set_student_flags(uuid, boolean, boolean) to authenticated;
