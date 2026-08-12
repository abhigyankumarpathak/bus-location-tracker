-- ===========================================================================
-- Did the patches actually land?
--
-- "Success. No rows returned" is what the SQL editor says for DDL, which
-- tells you nothing about whether the objects exist. This does.
--
-- Paste the whole file into the Supabase SQL editor. Every row should be OK;
-- anything MISSING sorts to the top.
-- ===========================================================================

-- Did the two patches actually land? Paste this whole thing into the
-- Supabase SQL editor. Every row should say OK.
with expected(kind, name, label) as (values
  ('table',  'watchdog_alerts',            'C2 · watchdog alerts table'),
  ('table',  'arrival_alerts',             'C6 · arrival alert ledger'),
  ('column', 'trip_stop_progress.departed_with_unresolved', 'C1 · leave-anyway flag'),
  ('column', 'trip_stop_progress.skipped', 'S9 · explicit skipped'),
  ('column', 'organization.watchdog_enabled',   'C2 · watchdog switch'),
  ('column', 'organization.undo_window_sec',    'C5 · undo window'),
  ('column', 'notifications.delivery_state',    'S6 · push delivery record'),
  ('column', 'notifications.requires_ack',      'S6 · acknowledgement'),
  ('column', 'announcements.student_id',        'N5 · child-targeted announcements'),
  ('func',   'transport_watchdog',         'C2 · the watchdog'),
  ('func',   'send_arrival_alerts',        'C6 · 15/5 minute alerts'),
  ('func',   'report_delay',               'S1 · structured delay'),
  ('func',   'undo_rider_status',          'C5 · undo a mistap'),
  ('func',   'undo_stop_progress',         'C5 · undo arrive/depart'),
  ('func',   'ensure_todays_trips',        'S8 · safe trip generation'),
  ('func',   'find_rider_today',           'C7 · whose van is this child on'),
  ('func',   'board_at_other_stop',        'C7 · board at the wrong hub'),
  ('func',   'guard_rider_transition',     'C8 · transition table'),
  ('func',   'within_checkin_window',      'N2 · check-in window'),
  ('trigger','on_stop_departure',          'C1 · departure guard'),
  ('trigger','on_rider_transition',        'C8 · transition guard'),
  ('trigger','on_boarding_after_away',     'C4 · note required'),
  ('trigger','on_stop_departed',           'S7 · departure notification'),
  ('trigger','on_announcement_posted',     'N5 · targeted fan-out')
)
select
  case when found then '✅ OK  ' else '❌ MISSING' end as status,
  label
from (
  select e.label, e.kind, e.name,
    case e.kind
      when 'table' then exists (
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = e.name)
      when 'column' then exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = split_part(e.name, '.', 1)
          and column_name = split_part(e.name, '.', 2))
      when 'func' then exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = e.name)
      when 'trigger' then exists (
        select 1 from pg_trigger where tgname = e.name and not tgisinternal)
      else false
    end as found
  from expected e
) x
order by found, label;
