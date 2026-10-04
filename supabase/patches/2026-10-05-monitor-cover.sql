-- ---------------------------------------------------------------------------
-- A monitor who is away does not take their riders with them.
--
-- THE BUG THIS FIXES, first, because it is the reason the feature is needed.
--
-- monitor_assignments() filtered expected absences out of the RIDERS pool and
-- not out of the MONITORS pool. A monitor could declare themselves away -- the
-- button has been on their screen since the attendance work, they are a student
-- like any other -- and the round-robin would deal them their usual share
-- anyway. Nobody else covered those riders. They showed "Not marked" that
-- evening, which is indistinguishable from a child who should be on the bus and
-- is not: the single signal the whole register exists to protect.
--
-- So the absence was already declarable and already ignored. That is the worst
-- shape for a gap like this, because the monitor has done the right thing and
-- been told nothing is wrong.
--
-- WHAT REDISTRIBUTION COSTS: nothing. The division was always computed rather
-- than stored, precisely so that either list changing would re-deal itself.
-- Removing an away monitor from the pool is therefore the whole of the "let the
-- active monitors manage more people" behaviour -- `r.idx % m.total` does it,
-- with m.total one smaller. No assignment table to update, nothing to rot.
--
-- WHY THE OFFICE IS STILL TOLD. Redistribution is silent and automatic, and
-- that is correct for one monitor off on a Tuesday. It is not correct when four
-- riders become eleven, and it is actively dangerous when the last monitor goes
-- away and the pool empties: monitor_assignments() then returns no rows at all,
-- every phone-less rider is unassigned, and the honest emptiness looks exactly
-- like a quiet evening. The notification is what makes the choice -- appoint
-- cover, or accept the bigger split -- a decision somebody takes rather than
-- one that happens to them.
--
-- Safe to re-run. Every statement is create-or-replace or guarded.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The round-robin, now over AVAILABLE monitors.
--
-- The only change to the body is the monitors CTE. Both pools now use
-- absent_on() rather than an inlined predicate: the span logic (null end_date
-- means one day, cancelled_at means withdrawn) was duplicated here, and a
-- duplicated subtlety is one that eventually disagrees with itself.
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
  -- A monitor who has declared themselves away is NOT dealt anybody. This is
  -- the fix: they used to be, and their riders went unconfirmed.
  --
  -- The left join and coalesce are kept from the roll-leftjoin patch. An inner
  -- join here would be equivalent today, since is_monitor cannot be true
  -- without a students row -- but the two pools are read together and having
  -- one of them silently drop a student with no students row is the bug that
  -- patch fixed.
  monitors as (
    select p.id, p.full_name,
           (row_number() over (order by p.full_name, p.id)) - 1 as idx,
           count(*) over () as total
    from profiles p
    left join students s on s.student_id = p.id
    cross join d
    where p.role = 'student' and p.status = 'active'
      and coalesce(s.is_monitor, false)
      and absent_on(p.id, d.day) is null
  ),
  -- Phone-less, and NOT expected away. A monitor asked to account for a child
  -- whose parents have already said they are not coming would either mark them
  -- wrongly present or report a false absence; neither is worth their time.
  riders as (
    select p.id, p.full_name,
           (row_number() over (order by p.full_name, p.id)) - 1 as idx
    from profiles p
    left join students s on s.student_id = p.id
    cross join d
    where p.role = 'student' and p.status = 'active'
      and not coalesce(s.has_phone, true)
      and not coalesce(s.is_monitor, false)
      and absent_on(p.id, d.day) is null
  )
  -- With every monitor away this join has no right-hand rows, so it yields
  -- nothing rather than dividing by zero. That emptiness is handled by
  -- monitor_cover() below, which is what tells somebody about it.
  select m.id, m.full_name, r.id, r.full_name,
         a.id is not null, a.marked_at, a.source
  from riders r
  cross join d
  join monitors m on m.idx = r.idx % m.total
  left join attendance a on a.student_id = r.id and a.on_date = d.day
  order by m.full_name, r.full_name;
$$;

revoke execute on function monitor_assignments(date) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Is anybody uncovered, and how hard is everyone else working?
--
-- Exists so both the office screen and the notification below read the same
-- numbers from the same place. `unassigned` is the one that matters: it is
-- non-zero only when the monitor pool has emptied, which is the case where the
-- register silently stops meaning anything.
-- ---------------------------------------------------------------------------
create or replace function monitor_cover(on_day date default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  with d as (select coalesce(on_day, today_local()) as day),
  mon as (
    select p.id, p.full_name, absent_on(p.id, (select day from d)) is not null as away
    from profiles p
    left join students s on s.student_id = p.id
    where p.role = 'student' and p.status = 'active' and coalesce(s.is_monitor, false)
  ),
  avail as (select count(*) as n from mon where not away),
  riders as (
    select count(*) as n
    from profiles p
    left join students s on s.student_id = p.id
    where p.role = 'student' and p.status = 'active'
      and not coalesce(s.has_phone, true) and not coalesce(s.is_monitor, false)
      and absent_on(p.id, (select day from d)) is null
  )
  select jsonb_build_object(
    'day',                (select day from d),
    'monitors_total',     (select count(*) from mon),
    'monitors_available', (select n from avail),
    'monitors_away',      (select coalesce(jsonb_agg(full_name order by full_name), '[]'::jsonb)
                           from mon where away),
    'riders_to_cover',    (select n from riders),
    -- Null rather than zero when nobody is available: "each monitor covers 0"
    -- would read as no work to do, when it means no one to do it.
    'each_monitor_covers', case when (select n from avail) = 0 then null
                                else ceil((select n from riders)::numeric
                                          / (select n from avail)) end,
    'unassigned',          case when (select n from avail) = 0 then (select n from riders)
                                else 0 end
  );
$$;

revoke execute on function monitor_cover(date) from public, anon;
grant execute on function monitor_cover(date) to authenticated;


-- ---------------------------------------------------------------------------
-- Tell the office when a monitor's absence changes the cover.
--
-- A trigger rather than a branch inside declare_absence(), because the office
-- needs telling however the row arrived -- including a staff member entering it
-- on a student's behalf, which does not go through the student path.
-- ---------------------------------------------------------------------------
create or replace function notify_on_monitor_absence() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  is_mon    boolean;
  name      text;
  span      text;
  cover     jsonb;
  avail     int;
  riders    int;
  audience  uuid[];
  cancelled boolean := false;
begin
  -- Only a monitor's absence changes who can confirm whom. Everyone else's is
  -- already handled by declare_absence().
  select s.is_monitor into is_mon from students s where s.student_id = new.student_id;
  if not coalesce(is_mon, false) then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- The moment of cancellation is news. Any other edit to the row is not, and
    -- re-announcing it would train the office to ignore these.
    if not (old.cancelled_at is null and new.cancelled_at is not null) then
      return new;
    end if;
    cancelled := true;
  end if;

  select coalesce(nullif(full_name, ''), 'A bus monitor') into name
  from profiles where id = new.student_id;

  span := case
            when new.end_date is null or new.end_date = new.on_date
              then to_char(new.on_date, 'FMDay DD Mon')
            else to_char(new.on_date, 'FMDD Mon') || ' to ' || to_char(new.end_date, 'FMDD Mon')
          end;

  -- Measured on the first day of the span. A monitor away for a fortnight does
  -- not change the shape of the problem, only its length.
  cover  := monitor_cover(new.on_date);
  avail  := (cover->>'monitors_available')::int;
  riders := (cover->>'riders_to_cover')::int;

  select array_agg(id) into audience from profiles
  where role in ('coordinator', 'admin') and status = 'active';

  if audience is null then
    return new;
  end if;

  insert into notifications (user_id, title, body, kind)
  select distinct u,
    case when cancelled then name || ' is back on the bus, ' || span
         else name || ' (bus monitor) is away ' || span end,
    case
      when cancelled then
        name || ' cancelled that absence and is covering their own riders again. '
        || 'Nothing to do; if you appointed cover you can stand it down.'
      -- The dangerous case. An empty monitor pool makes monitor_assignments()
      -- return nothing, which on screen looks like a quiet evening rather than
      -- like every phone-less child being unaccounted for.
      when avail = 0 then
        'NO MONITOR IS LEFT. The ' || riders || ' rider(s) without a phone cannot be '
        || 'confirmed by anyone on ' || span || ', so every one of them will show as '
        || 'not marked and no family will be told. Appoint another monitor on the '
        || 'Riders screen.'
      else
        'Their riders have already been shared out automatically: ' || avail
        || ' monitor(s) now cover ' || riders || ' rider(s), about '
        || coalesce(cover->>'each_monitor_covers', '?') || ' each. Nothing needs doing. '
        || 'Appoint another monitor on the Riders screen only if that is too many to ask.'
    end,
    'monitor_absence'
  from unnest(audience) as u where u is not null;

  return new;
end;
$$;

drop trigger if exists on_monitor_absence on attendance_absence;
create trigger on_monitor_absence
  after insert or update on attendance_absence
  for each row execute function notify_on_monitor_absence();


-- ---------------------------------------------------------------------------
-- What the register looks like right now. Run it to see the current cover.
-- ---------------------------------------------------------------------------
select monitor_cover();
