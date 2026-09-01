-- ---------------------------------------------------------------------------
-- Expected absences, in attendance-only mode.
--
-- Without this the register can only count. 45 students, 10 of whom nobody
-- expects, and one who should be there and is not, all collapse into "34 of 45"
-- -- which buries the single fact worth acting on under ten that are fine. The
-- point of a register is the person who is missing and should not be.
--
-- So a student can be EXPECTED to be away, and the denominator moves: 45 total,
-- 10 expected away, 34 scanned, and the number the office reads is 34/35 with
-- ONE name under it.
--
-- WHO CAN DECLARE ONE. A parent, for their own children, over a date range. A
-- student, for themselves -- "not on the bus, club" -- and their guardians are
-- told, because a child telling the school something their parents have not
-- heard is exactly the gap this app exists to close. Staff, for anyone.
--
-- AN ABSENCE IS NOT A BLOCK. A club that cancels at the last minute puts a
-- student back on the bus, and the app's job is to record that, not to prevent
-- it. Scanning while marked away SUCCEEDS, supersedes the absence, and tells the
-- guardians in different words -- the same rule the full app follows with
-- "Boarding anyway", and for the same reason: refusing the write does not stop
-- the child getting on, it only stops anyone knowing they did.
-- ---------------------------------------------------------------------------

create table if not exists attendance_absence (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references profiles on delete cascade,

  -- A SPAN, not a row per day. A fortnight away is one thing to declare and one
  -- thing to cancel; expanding it into fourteen rows makes cancelling it a
  -- fourteen-step job and the history unreadable.
  on_date     date not null,
  end_date    date,
  kind        text not null default 'absent' check (kind in ('absent', 'club', 'other')),
  reason      text,

  declared_by uuid references profiles on delete set null,
  source      text not null check (source in ('parent', 'student', 'staff')),
  created_at  timestamptz not null default now(),

  -- Cancelled rather than deleted: "they said they were away and then changed
  -- their mind" is a different fact from "nobody ever said anything", and the
  -- second is what a deleted row would look like.
  cancelled_at timestamptz,
  cancelled_by uuid references profiles on delete set null,

  constraint absence_span_ordered check (end_date is null or end_date >= on_date)
);

create index if not exists attendance_absence_student_idx
  on attendance_absence (student_id, on_date desc);
create index if not exists attendance_absence_span_idx
  on attendance_absence (on_date, end_date);

alter table attendance_absence enable row level security;

drop policy if exists "read own absence" on attendance_absence;
create policy "read own absence" on attendance_absence for select using (
  (is_active() and (student_id = auth.uid() or is_guardian_of(student_id)))
  or is_staff()
);

drop policy if exists "staff manage absence" on attendance_absence;
create policy "staff manage absence" on attendance_absence
  for all using (is_staff()) with check (is_staff());


-- Is this student expected away on `d`?
create or replace function absent_on(target uuid, d date)
returns attendance_absence
language sql stable security definer set search_path = public as $$
  select a.* from attendance_absence a
  where a.student_id = target
    and a.cancelled_at is null
    and a.on_date <= d
    and coalesce(a.end_date, a.on_date) >= d
  order by a.created_at desc
  limit 1;
$$;

revoke execute on function absent_on(uuid, date) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Declaring one.
--
-- Security definer because a parent has no write policy on this table and a
-- student certainly does not -- who may speak for whom is decided here, once,
-- rather than in a policy expression that has to encode three different rules.
-- ---------------------------------------------------------------------------
create or replace function declare_absence(
  target    uuid,
  from_date date,
  to_date   date default null,
  kind      text default 'absent',
  reason    text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me        uuid := auth.uid();
  who       text;
  name      text;
  span      text;
  audience  uuid[];
  new_id    uuid;
begin
  if me is null or not is_active() then
    return jsonb_build_object('ok', false, 'message', 'Sign in first.');
  end if;

  if kind not in ('absent', 'club', 'other') then
    return jsonb_build_object('ok', false, 'message', 'Unknown kind of absence.');
  end if;

  -- Who is allowed to speak for this student.
  if is_staff() then
    who := 'staff';
  elsif target = me then
    who := 'student';
  elsif is_guardian_of(target) then
    who := 'parent';
  else
    return jsonb_build_object('ok', false,
      'message', 'You can only do this for your own children.');
  end if;

  if to_date is not null and to_date < from_date then
    return jsonb_build_object('ok', false, 'message', 'The last day cannot be before the first.');
  end if;

  -- Backdating would rewrite a register somebody has already read and acted on.
  if from_date < today_local() then
    return jsonb_build_object('ok', false,
      'message', 'That date has passed. The office can correct a past day.');
  end if;

  insert into attendance_absence (student_id, on_date, end_date, kind, reason, declared_by, source)
  values (target, from_date, nullif(to_date, from_date), kind, nullif(btrim(reason), ''), me, who)
  returning id into new_id;

  select full_name into name from profiles where id = target;
  name := coalesce(nullif(name, ''), 'Your child');
  span := case
            when to_date is null or to_date = from_date then to_char(from_date, 'FMDay DD Mon')
            else to_char(from_date, 'FMDD Mon') || ' to ' || to_char(to_date, 'FMDD Mon')
          end;

  -- A STUDENT declaring for themselves is the case this notification exists
  -- for: the school now knows something the family may not, and a child who is
  -- not on the bus is precisely what a parent needs telling about.
  if who = 'student' then
    select array_agg(parent_id) into audience from guardian_links
    where student_id = target and status = 'accepted';

    if audience is not null then
      insert into notifications (user_id, title, body, kind)
      select distinct u,
             name || ' says they will not be on the bus',
             case kind
               when 'club' then name || ' has told the school they are staying for a club on ' || span || '.'
               else name || ' has told the school they will not be riding on ' || span || '.'
             end
             || coalesce(' Reason given: ' || nullif(btrim(reason), '') || '.', '')
             || ' They told us, not you — check with them if this is a surprise.',
             'absence_declared'
      from unnest(audience) as u where u is not null;
    end if;

  -- A parent or the office declaring: tell the STUDENT, so they are not left
  -- waiting at a door for a bus nobody expects them on.
  else
    insert into notifications (user_id, title, body, kind)
    values (target, 'You are marked as not riding',
            'You have been marked as not on the bus for ' || span || '.'
            || coalesce(' Reason: ' || nullif(btrim(reason), '') || '.', '')
            || ' If that is wrong, tell the office — and you can still scan on if you do ride.',
            'absence_declared');
  end if;

  return jsonb_build_object('ok', true, 'id', new_id, 'span', span, 'declared_by', who);
end;
$$;

revoke execute on function declare_absence(uuid, date, date, text, text) from public, anon;
grant execute on function declare_absence(uuid, date, date, text, text) to authenticated;


create or replace function cancel_absence(absence_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me  uuid := auth.uid();
  row attendance_absence;
begin
  select * into row from attendance_absence where id = absence_id;
  if row.id is null then
    return jsonb_build_object('ok', false, 'message', 'Not found.');
  end if;

  if not (is_staff() or row.student_id = me or is_guardian_of(row.student_id)) then
    return jsonb_build_object('ok', false, 'message', 'That is not yours to cancel.');
  end if;

  update attendance_absence
  set cancelled_at = now(), cancelled_by = me
  where id = absence_id and cancelled_at is null;

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function cancel_absence(uuid) from public, anon;
grant execute on function cancel_absence(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- Marking attendance, now that "expected away" exists.
--
-- The club cancelled and the student is on the bus after all. That must WORK.
-- Refusing the scan would not keep them off the bus; it would only mean nobody
-- knew they were on it, which is the failure this whole app is built against.
-- ---------------------------------------------------------------------------
create or replace function mark_attendance(code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me       uuid := auth.uid();
  cfg      organization;
  expected text;
  opens    timestamptz;
  already  attendance;
  excuse   attendance_absence;
  name     text;
  audience uuid[];
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

  select * into already from attendance a
  where a.student_id = me and a.on_date = today_local();

  if already.id is not null then
    return jsonb_build_object('ok', true, 'tone', 'warn', 'reason', 'already_marked',
      'at', to_char(already.marked_at, 'HH12:MI AM'),
      'message', 'You are already marked attended, at '
                 || to_char(already.marked_at, 'HH12:MI AM') || '.');
  end if;

  -- Were they down as away? Board them anyway, and say so.
  select * into excuse from absent_on(me, today_local());

  insert into attendance (student_id, on_date, source, marked_by, note)
  values (me, today_local(), 'scan', me,
          case when excuse.id is not null
               then 'Was marked as not riding (' || excuse.kind || '); scanned on anyway.'
          end);

  if excuse.id is null then
    return jsonb_build_object('ok', true, 'tone', 'success', 'reason', 'marked',
      'at', to_char(now(), 'HH12:MI AM'), 'message', 'Marked attended.');
  end if;

  -- The absence is superseded, not deleted -- it is still true that they said
  -- they were not coming, and the history should keep both halves.
  update attendance_absence
  set cancelled_at = now(), cancelled_by = me
  where id = excuse.id;

  select full_name into name from profiles where id = me;
  name := coalesce(nullif(name, ''), 'Your child');

  select array_agg(parent_id) into audience from guardian_links
  where student_id = me and status = 'accepted';

  if audience is not null then
    insert into notifications (user_id, title, body, kind)
    select distinct u,
           name || ' is on the bus after all',
           name || ' was down as not riding today'
           || case when excuse.kind = 'club' then ' because of a club' else '' end
           || ', and has just scanned on at ' || to_char(now(), 'HH12:MI AM')
           || '. If the club was cancelled, this is expected.',
           'attendance_after_absence'
    from unnest(audience) as u where u is not null;
  end if;

  return jsonb_build_object('ok', true, 'tone', 'success', 'reason', 'marked_after_absence',
    'at', to_char(now(), 'HH12:MI AM'),
    'message', 'Marked attended. You were down as not riding, so your family has been told '
               || 'you are on the bus after all.');
end;
$$;

revoke execute on function mark_attendance(text) from public, anon;
grant execute on function mark_attendance(text) to authenticated;


-- ---------------------------------------------------------------------------
-- The register, with a denominator that means something.
-- ---------------------------------------------------------------------------
create or replace function attendance_register(on_day date default null)
returns table (
  student_id    uuid,
  full_name     text,
  present       boolean,
  marked_at     timestamptz,
  source        text,
  note          text,
  excused       boolean,
  excuse_kind   text,
  excuse_reason text,
  excuse_id     uuid
)
language sql stable security definer set search_path = public as $$
  with d as (select coalesce(on_day, today_local()) as day)
  select p.id,
         p.full_name,
         a.id is not null,
         a.marked_at,
         a.source,
         a.note,
         x.id is not null,
         x.kind,
         x.reason,
         x.id
  from profiles p
  cross join d
  left join attendance a
    on a.student_id = p.id and a.on_date = d.day
  left join lateral (
    select * from attendance_absence ab
    where ab.student_id = p.id
      and ab.cancelled_at is null
      and ab.on_date <= d.day
      and coalesce(ab.end_date, ab.on_date) >= d.day
    order by ab.created_at desc limit 1
  ) x on true
  where is_staff()
    and p.role = 'student'
    and p.status = 'active'
  -- Missing-and-not-excused first: that is the whole reason to open this screen.
  order by (a.id is not null or x.id is not null), p.full_name;
$$;

revoke execute on function attendance_register(date) from public, anon;
grant execute on function attendance_register(date) to authenticated;
