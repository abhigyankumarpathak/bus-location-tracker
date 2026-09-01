-- ---------------------------------------------------------------------------
-- ATTENDANCE-ONLY MODE
--
-- A switch that turns this from a transport platform into an attendance
-- register. With it on: no routes, no trips, no vehicles, no check-in, no
-- driver. A student scans one printed code and is marked present for that
-- evening; a parent sees whether their child boarded; staff see the register.
--
-- IT IS A TOGGLE, AND NOTHING IS DESTROYED BY IT. Every route, trip, hub and
-- rider row stays exactly where it was and is simply not shown. Turn it back
-- off and the full platform returns with its history intact. That is the whole
-- design constraint: an operator who tries this must be able to change their
-- mind at four o'clock on a Tuesday.
--
-- WHAT IT IS NOT. This does not claim to know where a child is, only that they
-- presented a code at a door after noon. There is no van, no driver
-- confirmation, and no custody chain — so nothing here may be worded as though
-- there were.
--
-- THE INTEGRITY TRADE, STATED PLAINLY. The code is printed once and does not
-- rotate. That was chosen deliberately over a rotating on-screen code, and it
-- means a photograph of the card marks its holder present from anywhere, on any
-- evening, until somebody reissues it. The evening lock narrows the window; it
-- does not close the hole. `rotate_attendance_code()` exists because the day
-- will come when it has to be used.
-- ---------------------------------------------------------------------------

alter table organization
  -- The master switch.
  add column if not exists attendance_only boolean not null default false,
  -- "This is only for evenings." Wall-clock, in the operation's own timezone --
  -- a UTC comparison here would open the register at 8am local.
  add column if not exists attendance_opens_at time not null default '12:00';

comment on column organization.attendance_only is
  'Attendance-only mode: hide routes, trips, vehicles and check-in; show the register. Fully reversible.';


-- The printed code's secret.
--
-- Its OWN TABLE, never a column on `organization`, for the same reason
-- device_key is not on `vehicles`: RLS is row-level, not column-level, and
-- `organization` is readable by every active signed-in user. A code stored there
-- would be fetchable from the API by any student, who could then mark themselves
-- present without ever leaving the house or seeing the card.
create table if not exists attendance_code (
  id         int primary key default 1 check (id = 1),
  code       text unique not null default encode(gen_random_bytes(12), 'hex'),
  rotated_at timestamptz not null default now(),
  rotated_by uuid references profiles on delete set null
);

insert into attendance_code (id) values (1) on conflict (id) do nothing;

alter table attendance_code enable row level security;

-- Staff print it. Nobody else may read it, and nobody at all may read it through
-- PostgREST as a student.
drop policy if exists "staff read attendance code" on attendance_code;
create policy "staff read attendance code" on attendance_code
  for select using (is_staff());


-- ---------------------------------------------------------------------------
-- The register.
--
-- One row per student per day means "present". The ABSENCE of a row means not
-- boarded -- there is deliberately no `absent` row, because that would be a
-- claim nobody made. Nothing wrote it; nobody observed it; it is simply the
-- lack of a scan.
-- ---------------------------------------------------------------------------
create table if not exists attendance (
  id         uuid primary key default gen_random_uuid(),
  student_id uuid not null references profiles on delete cascade,
  on_date    date not null,
  marked_at  timestamptz not null default now(),

  -- How it got here. A scan and a staff correction are different kinds of fact
  -- and must never be presentable as the same one.
  source     text not null default 'scan' check (source in ('scan', 'staff')),
  marked_by  uuid references profiles on delete set null,
  note       text,

  -- One mark per student per day. Also what makes a double scan a no-op rather
  -- than a duplicate.
  unique (student_id, on_date)
);

create index if not exists attendance_date_idx on attendance (on_date desc);
create index if not exists attendance_student_idx on attendance (student_id, on_date desc);

alter table attendance enable row level security;

drop policy if exists "read own attendance" on attendance;
create policy "read own attendance" on attendance for select using (
  (is_active() and (student_id = auth.uid() or is_guardian_of(student_id)))
  or is_staff()
);

-- Staff may mark, correct and remove. A student may not write here AT ALL --
-- mark_attendance() below is security definer and is the only door, exactly as
-- board_by_vehicle_code() is for boarding.
drop policy if exists "staff manage attendance" on attendance;
create policy "staff manage attendance" on attendance
  for all using (is_staff()) with check (is_staff());


-- ---------------------------------------------------------------------------
-- Marking yourself present.
--
-- Returns a jsonb verdict rather than raising, for the same reason
-- board_by_vehicle_code() does: every outcome is something a teenager standing
-- in a doorway has to be able to act on, and a Postgres exception is not that.
-- ---------------------------------------------------------------------------
create or replace function mark_attendance(code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me       uuid := auth.uid();
  cfg      organization;
  expected text;
  opens    timestamptz;
  already  attendance;
begin
  if me is null then
    return jsonb_build_object('ok', false, 'tone', 'danger', 'reason', 'signed_out',
      'message', 'Sign in first, then scan.');
  end if;

  if not is_active() then
    return jsonb_build_object('ok', false, 'tone', 'danger', 'reason', 'inactive',
      'message', 'This account is not active. Talk to the office.');
  end if;

  select * into cfg from organization where id = 1;

  if not cfg.attendance_only then
    return jsonb_build_object('ok', false, 'tone', 'danger', 'reason', 'not_enabled',
      'message', 'Attendance mode is not switched on.');
  end if;

  -- THE EVENING LOCK, before the code is even looked at. A student scanning at
  -- breakfast should be told the rule, not told their code is wrong.
  opens := local_ts(today_local(), cfg.attendance_opens_at);
  if now() < opens then
    return jsonb_build_object('ok', false, 'tone', 'warn', 'reason', 'too_early',
      'message', 'This is only for evenings. Attendance opens at '
                 || to_char(cfg.attendance_opens_at, 'HH12:MI AM') || '.');
  end if;

  select ac.code into expected from attendance_code ac where ac.id = 1;
  if expected is null or btrim(code) <> expected then
    return jsonb_build_object('ok', false, 'tone', 'danger', 'reason', 'unknown_code',
      'message', 'That is not this school''s code. Ask a member of staff.');
  end if;

  -- A second scan is the most likely mistap there is, and must not read as a
  -- failure.
  select * into already from attendance a
  where a.student_id = me and a.on_date = today_local();

  if already.id is not null then
    return jsonb_build_object('ok', true, 'tone', 'warn', 'reason', 'already_marked',
      'at', to_char(already.marked_at, 'HH12:MI AM'),
      'message', 'You are already marked attended, at '
                 || to_char(already.marked_at, 'HH12:MI AM') || '.');
  end if;

  insert into attendance (student_id, on_date, source, marked_by)
  values (me, today_local(), 'scan', me);

  return jsonb_build_object('ok', true, 'tone', 'success', 'reason', 'marked',
    'at', to_char(now(), 'HH12:MI AM'),
    'message', 'Marked attended.');
end;
$$;

revoke execute on function mark_attendance(text) from public, anon;
grant execute on function mark_attendance(text) to authenticated;


-- What staff need to print the card. Its own function because attendance_code
-- is staff-read-only and this is the narrow, intentional way through.
create or replace function attendance_card() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when is_staff() then
    jsonb_build_object('code', ac.code, 'rotated_at', ac.rotated_at)
  end
  from attendance_code ac where ac.id = 1;
$$;

revoke execute on function attendance_card() from public, anon;
grant execute on function attendance_card() to authenticated;


-- A printed card can be photographed, and with a static code that is the whole
-- risk. Reissuing has to be reachable without a database console at the moment
-- somebody notices the numbers are wrong.
create or replace function rotate_attendance_code() returns text
language plpgsql security definer set search_path = public as $$
declare
  fresh text := encode(gen_random_bytes(12), 'hex');
begin
  if not is_admin() then
    raise exception 'Only an administrator can reissue the attendance code.';
  end if;

  update attendance_code
  set code = fresh, rotated_at = now(), rotated_by = auth.uid()
  where id = 1;

  insert into audit_logs (entity_type, entity_id, action, reason, changed_by)
  values ('attendance_code', null, 'rotated',
          'Attendance code reissued; every printed card is now void.', auth.uid());

  return fresh;
end;
$$;

revoke execute on function rotate_attendance_code() from public, anon;
grant execute on function rotate_attendance_code() to authenticated;


-- ---------------------------------------------------------------------------
-- Staff marking a student present by hand.
--
-- A flat battery otherwise means an absent record for a student standing in
-- front of you. `source` records that this was a person's judgement rather than
-- a scan, so the two are never presented as the same fact.
-- ---------------------------------------------------------------------------
create or replace function set_attendance(target uuid, present boolean, reason text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then
    raise exception 'Only the office can mark attendance by hand.';
  end if;

  if present then
    insert into attendance (student_id, on_date, source, marked_by, note)
    values (target, today_local(), 'staff', auth.uid(), reason)
    on conflict (student_id, on_date) do update
      set source = 'staff', marked_by = auth.uid(), note = excluded.note;
  else
    -- Removing the row IS the record of "not present". There is no absent row
    -- to write; see the note on the table.
    delete from attendance where student_id = target and on_date = today_local();
  end if;

  insert into audit_logs (entity_type, entity_id, action, new_value, reason, changed_by)
  values ('attendance', target,
          case when present then 'marked_present' else 'mark_removed' end,
          jsonb_build_object('on_date', today_local()), reason, auth.uid());

  return jsonb_build_object('ok', true, 'present', present);
end;
$$;

revoke execute on function set_attendance(uuid, boolean, text) from public, anon;
grant execute on function set_attendance(uuid, boolean, text) to authenticated;


-- ---------------------------------------------------------------------------
-- Today's register, in one query, for the staff screen.
--
-- Every active student, whether or not they have scanned -- the useful screen
-- is "who is NOT here", and that cannot be built from the attendance table
-- alone because a missing student is a missing ROW.
-- ---------------------------------------------------------------------------
create or replace function attendance_register(on_day date default null)
returns table (
  student_id uuid,
  full_name  text,
  present    boolean,
  marked_at  timestamptz,
  source     text,
  note       text
)
language sql stable security definer set search_path = public as $$
  select p.id,
         p.full_name,
         a.id is not null,
         a.marked_at,
         a.source,
         a.note
  from profiles p
  left join attendance a
    on a.student_id = p.id
   and a.on_date = coalesce(on_day, today_local())
  where is_staff()
    and p.role = 'student'
    and p.status = 'active'
  order by (a.id is not null), p.full_name;
$$;

revoke execute on function attendance_register(date) from public, anon;
grant execute on function attendance_register(date) to authenticated;
