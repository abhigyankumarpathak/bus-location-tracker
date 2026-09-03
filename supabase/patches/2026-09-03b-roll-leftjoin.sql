-- ---------------------------------------------------------------------------
-- A missing `students` row must not hide a child.
--
-- attendance_roll() and monitor_assignments() INNER JOINED students, which is
-- the row handle_new_user() creates alongside a student's profile. Any student
-- who arrived another way -- seeded by SQL, or given the student role after
-- signing up as something else -- has a profile and no students row, and
-- vanished from both. The Riders screen showed an empty list and gave no reason,
-- which is the worst shape a bug can take: the screen looked like it worked.
--
-- Left-joined with the column defaults, so a student with no row appears as
-- "has a phone, not a monitor" -- which is what the defaults mean anyway. And
-- set_student_flags() now CREATES the row rather than raising, so the first
-- attempt to fix such a student succeeds instead of reporting "no record".
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
    left join students s on s.student_id = p.id
    where p.role = 'student' and p.status = 'active'
      and coalesce(s.is_monitor, false)
  ),
  riders as (
    select p.id, p.full_name,
           (row_number() over (order by p.full_name, p.id)) - 1 as idx
    from profiles p
    left join students s on s.student_id = p.id
    cross join d
    where p.role = 'student' and p.status = 'active'
      and not coalesce(s.has_phone, true)
      and not coalesce(s.is_monitor, false)
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


create or replace function attendance_roll()
returns table (
  student_id uuid,
  full_name  text,
  has_phone  boolean,
  is_monitor boolean,
  answers_to text
)
language sql stable security definer set search_path = public as $$
  select p.id,
         p.full_name,
         coalesce(s.has_phone, true),
         coalesce(s.is_monitor, false),
         m.monitor_name
  from profiles p
  left join students s on s.student_id = p.id
  left join lateral (
    select a.monitor_name from monitor_assignments(today_local()) a
    where a.student_id = p.id limit 1
  ) m on true
  where is_staff() and p.role = 'student' and p.status = 'active'
  order by coalesce(s.is_monitor, false) desc, coalesce(s.has_phone, true), p.full_name;
$$;

revoke execute on function attendance_roll() from public, anon;
grant execute on function attendance_roll() to authenticated;


create or replace function set_student_flags(
  target  uuid,
  phone   boolean default null,
  monitor boolean default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then
    raise exception 'Only the office can change this.';
  end if;

  if not exists (select 1 from profiles where id = target and role = 'student') then
    raise exception 'That account is not a student.';
  end if;

  -- Creates the row when it is missing rather than failing. A student without
  -- one is the case this patch exists for, and refusing to fix them would leave
  -- the only route out a manual insert nobody would think to make.
  insert into students (student_id, has_phone, is_monitor)
  values (target, coalesce(phone, true), coalesce(monitor, false))
  on conflict (student_id) do update
    set has_phone  = coalesce(phone, students.has_phone),
        is_monitor = coalesce(monitor, students.is_monitor);

  insert into audit_logs (entity_type, entity_id, action, new_value, changed_by)
  values ('students', target, 'flags_changed',
          jsonb_build_object('has_phone', phone, 'is_monitor', monitor), auth.uid());

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function set_student_flags(uuid, boolean, boolean) from public, anon;
grant execute on function set_student_flags(uuid, boolean, boolean) to authenticated;

-- Backfill anyone who never got one. Harmless if there are none.
insert into students (student_id)
select p.id from profiles p
where p.role = 'student'
  and not exists (select 1 from students s where s.student_id = p.id);

-- PostgREST caches the schema. A new function is invisible to the API until it
-- reloads, which surfaces as "Could not find the function ... in the schema
-- cache" even though the function plainly exists.
notify pgrst, 'reload schema';
