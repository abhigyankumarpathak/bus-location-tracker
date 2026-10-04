-- ===========================================================================
-- What is actually SWITCHED ON?
--
-- verify.sql answers "did the DDL land". Every row of it can say OK while the
-- system does nothing useful, because almost everything here is a setting, a
-- publication, a cron job or a row of data -- none of which is an object whose
-- existence can be checked.
--
-- Three things verify.sql cannot see at all:
--   * the realtime publication (a list of tables, not a schema object)
--   * retention.sql (never checked by verify.sql -- zero of its objects are in it)
--   * pg_cron, and whether any job is scheduled
--
-- Paste the whole file into the Supabase SQL editor. Read the `state` column.
-- Rows needing attention sort to the top.
-- ===========================================================================

with
-- -------------------------------------------------------------- realtime
rt as (
  select count(*) as n,
         string_agg(tablename, ', ' order by tablename) as tables
  from pg_publication_tables
  where pubname = 'supabase_realtime' and schemaname = 'public'
),
-- ------------------------------------------------------------- retention
ret as (
  select
    exists (select 1 from information_schema.tables
            where table_schema = 'public' and table_name = 'weekly_reports') as archive,
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'run_weekly_maintenance') as job,
    exists (select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'organization'
              and column_name = 'retention_weeks') as weeks
),
-- ------------------------------------------------------------------ cron
-- cron.job is only queryable once the extension exists, so the count is taken
-- dynamically. A plain `from cron.job` would make this whole file fail to parse
-- on a project where pg_cron was never enabled -- which is the single most
-- likely state, and the one this row exists to report.
pgcron as (
  select
    exists (select 1 from pg_extension where extname = 'pg_cron') as installed
),
-- --------------------------------------------------------------- settings
org as (select * from organization where id = 1),
-- ----------------------------------------------------------------- people
ppl as (
  select
    (select count(*) from students s
       join profiles p on p.id = s.student_id
      where p.role = 'student' and p.status = 'active' and s.is_monitor)  as monitors,
    (select count(*) from students s
       join profiles p on p.id = s.student_id
      where p.role = 'student' and p.status = 'active' and not s.has_phone) as phoneless,
    -- A rider with no phone AND no linked parent is invisible to a family. They
    -- will be marked by a monitor and nobody will ever be told.
    (select count(*) from students s
       join profiles p on p.id = s.student_id
      where p.role = 'student' and p.status = 'active' and not s.has_phone
        and not exists (select 1 from guardian_links gl
                        where gl.student_id = s.student_id and gl.status = 'accepted')) as orphaned,
    (select count(*) from profiles where role = 'student' and status = 'active') as students_total,
    (select count(*) from profiles where role = 'parent'  and status = 'active') as parents_total
)
select * from (
  -- ---------------------------------------------------------------- realtime
  select 1 as sort_group,
    case when rt.n >= 13 then '✅' else '⚠️' end as state,
    'REALTIME · tables streaming' as item,
    rt.n || ' of 13 expected' as detail,
    case when rt.n >= 13 then 'Nothing to do.'
         else 'Run patches/2026-10-04-realtime.sql. Published: ' || coalesce(rt.tables, 'none') end as action
  from rt

  -- --------------------------------------------------------------- retention
  union all
  select 2,
    case when ret.archive and ret.job and ret.weeks then '✅' else '⚠️' end,
    'RETENTION · weekly archive installed',
    case when ret.archive and ret.job and ret.weeks then 'weekly_reports + run_weekly_maintenance present'
         else 'missing pieces' end,
    case when ret.archive and ret.job and ret.weeks then 'Nothing to do.'
         else 'Run supabase/retention.sql. It is additive and safe on live data. ' ||
              'Without it the register grows forever and nobody gets a weekly report.' end
  from ret

  -- -------------------------------------------------------------------- cron
  union all
  select 3,
    case when pgcron.installed then '✅' else '⚠️' end,
    'CRON · pg_cron extension',
    case when pgcron.installed then 'enabled' else 'NOT enabled' end,
    case when pgcron.installed
         then 'Enabled. Run the SCHEDULED JOBS query at the bottom of this file.'
         else 'Dashboard -> Database -> Extensions -> enable pg_cron. ' ||
              'Until then NOTHING runs on a schedule: no weekly purge, no trip ' ||
              'generation, no watchdog. Every one of those is a manual click.' end
  from pgcron

  -- ---------------------------------------------------------------- settings
  union all
  select 5,
    case when org.time_zone is null or org.time_zone = 'UTC' then '⚠️' else '✅' end,
    'CONFIG · time zone',
    coalesce(org.time_zone, 'NOT SET'),
    case when org.time_zone is null or org.time_zone = 'UTC'
         then 'Set it to the vans'' real zone, or every "today" rolls over at the ' ||
              'wrong hour: update organization set time_zone = ''America/New_York'' where id = 1;'
         else 'Nothing to do.' end
  from org

  union all
  select 6, 'ℹ️',
    'CONFIG · attendance-only mode',
    case when org.attendance_only then 'ON — routes, buses and driver hidden'
         else 'OFF — full transport app' end,
    'A deliberate choice, not a fault. Toggle in Setup.'
  from org

  union all
  select 7,
    case when org.attendance_opens_at is null then '⚠️' else '✅' end,
    'CONFIG · evening lock opens at',
    coalesce(org.attendance_opens_at::text, 'NOT SET'),
    case when org.attendance_opens_at is null
         then 'With no cutoff a student can mark themselves at breakfast.'
         else 'Students cannot scan before this time.' end
  from org

  union all
  select 8,
    case when exists (select 1 from attendance_code where id = 1) then '✅' else '⚠️' end,
    'CONFIG · printed card code exists',
    case when exists (select 1 from attendance_code where id = 1) then 'present' else 'MISSING' end,
    case when exists (select 1 from attendance_code where id = 1)
         then 'Read it from Setup and print the card. Never print the device key.'
         else 'insert into attendance_code (id) values (1) on conflict do nothing;' end

  -- ------------------------------------------------------------------ people
  union all
  select 9,
    case when ppl.monitors = 0 and ppl.phoneless > 0 then '❌'
         when ppl.monitors = 0 then '⚠️' else '✅' end,
    'PEOPLE · bus monitors',
    ppl.monitors || ' monitor(s) for ' || ppl.phoneless || ' rider(s) with no phone',
    case when ppl.monitors = 0 and ppl.phoneless > 0
         then 'NOBODY can confirm those riders. They show "Not marked" every ' ||
              'evening. Set one in Staff -> Riders.'
         when ppl.monitors = 0 then 'None needed yet — no phone-less riders.'
         else 'Covered.' end
  from ppl

  union all
  select 10,
    case when ppl.orphaned > 0 then '❌' else '✅' end,
    'PEOPLE · phone-less riders with no parent linked',
    ppl.orphaned || ' of ' || ppl.phoneless,
    case when ppl.orphaned > 0
         then 'These children are marked by a monitor and NO family is ever told. ' ||
              'Link them in Staff -> Riders; the parent cannot do it themselves ' ||
              'because there is no account to search for.'
         else 'Every phone-less rider has a family attached.' end
  from ppl

  union all
  select 11, 'ℹ️',
    'PEOPLE · roster size',
    ppl.students_total || ' students, ' || ppl.parents_total || ' parents',
    'For scale only.'
  from ppl
) checks
order by
  case state when '❌' then 0 when '⚠️' then 1 else 2 end,
  sort_group;


-- ===========================================================================
-- SCHEDULED JOBS — run this second, and only if pg_cron is enabled.
--
-- Separate because `cron.job` does not exist until the extension does, and a
-- missing relation is a parse error that would take the whole file with it.
--
-- Expect three jobs if you want the system to look after itself:
--   weekly-transport-maintenance   0 3 * * 0   archive + purge
--   daily-trips                    (weekday)   ensure_daily_trips()
--   transport-watchdog             (frequent)  transport_watchdog()
--
-- None of them is required for the attendance register to work. All three are
-- required for it to work without somebody remembering.
-- ===========================================================================

select jobname, schedule, active, command
from cron.job
order by jobname;
