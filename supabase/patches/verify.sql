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
  ('trigger','on_announcement_posted',     'N5 · targeted fan-out'),
  -- Not "does it exist" but "is it the FIXED one". Patch 3 rewrote this
  -- function; the stale-note bug is invisible to an existence check.
  ('body',   'guard_boarding_after_away|is not distinct from', 'C4 · stale-note fix (patch 3)'),
  ('column', 'organization.time_zone',      'TZ · the clock the vans run on (patch 4)'),
  ('func',   'local_ts',                    'TZ · planned times resolved locally (patch 4)'),
  ('body',   'transport_watchdog|local_ts', 'TZ · watchdog uses it (patch 4)'),
  ('body',   'send_arrival_alerts|local_ts','TZ · arrival alerts use it (patch 4)'),
  -- Self-scan: students scan the van, not the other way round (patch 5).
  ('column', 'vehicle_devices.board_code',  'SCAN · printed card secret'),
  ('func',   'board_by_vehicle_code',       'SCAN · the student boards themselves'),
  ('func',   'vehicle_board_codes',         'SCAN · what Setup prints'),
  ('func',   'rotate_board_code',           'SCAN · reissue a leaked card'),
  -- Existence is not enough here either. A scan that boarded a student
  -- standing anywhere on the route would be the whole risk of this feature
  -- shipped by accident, so check the stop guard is actually in the body.
  ('body',   'board_by_vehicle_code|van_not_here', 'SCAN · van must be AT the stop'),
  ('body',   'notify_on_rider_status|self_scanned','SCAN · parents told who confirmed it'),
  -- C3, the server half (patch 6). The queue is on the phone; these are what
  -- stop a queued boarding being RECORDED at flush time instead of board time.
  ('func',   'rider_event_time',            'C3 · when it happened, not when we heard'),
  ('body',   'log_rider_status|rider_event_time',     'C3 · audit log uses it'),
  ('body',   'notify_on_rider_status|rider_event_time','C3 · notifications use it'),
  ('body',   'notify_on_stop_departure|late_txt',     'C3 · late alerts say why'),
  -- The date itself (patch 7). current_date is the DATABASE's date, so on a
  -- UTC project every "today" rolled over hours early and the day's trips
  -- disappeared from every screen. Existence of today_local() proves nothing on
  -- its own -- what matters is that the callers actually use it, policies too.
  ('func',   'today_local',                          'DATE · the operation''s day'),
  ('body',   'ensure_daily_trips|today_local',       'DATE · trips generated on the local day'),
  ('body',   'transport_watchdog|today_local',       'DATE · watchdog reads the local day'),
  ('body',   'send_arrival_alerts|today_local',      'DATE · arrival alerts read the local day'),
  ('body',   'board_by_vehicle_code|today_local',    'DATE · self-scan reads the local day'),
  ('body',   'decide_change_request|today_local',    'DATE · cutoff judged on the local day'),
  ('policy', 'profiles|riders read their driver|today_local',
                                                     'DATE · driver-name policy, local day'),
  ('policy', 'vehicle_locations|read locations|today_local',
                                                     'DATE · van-position policy, local day'),
  -- The column no patch ever added (patch 7b). ensure_daily_trips() has read it
  -- since patch 2, so without it trip generation raised on every call -- into
  -- an error the app swallows, which is why it looked like an empty day rather
  -- than a fault. See drift.sql for the general form of this problem.
  ('column', 'change_requests.end_date',             'SPAN · multi-day requests'),
  ('body',   'apply_change_request|end_date',        'SPAN · applied across every day it covers'),
  -- The other never-patched column (7c). Nothing reads it since the self-scan
  -- flip, which is why it never raised -- schema.sql keeps it deliberately
  -- until the new model has survived a term.
  ('column', 'student_trip_status.boarding_code',    'SPAN · old per-rider scan token'),
  ('func',   'new_boarding_code',                    'SPAN · what generates it'),
  -- Attendance-only mode (patch 8). A toggle, so every check here is about the
  -- machinery existing, not about it being switched on.
  ('column', 'organization.attendance_only',         'ATTEND · the toggle'),
  ('column', 'organization.attendance_opens_at',     'ATTEND · the evening lock'),
  ('table',  'attendance',                           'ATTEND · the register'),
  ('table',  'attendance_code',                      'ATTEND · the printed card secret'),
  ('func',   'mark_attendance',                      'ATTEND · a student marks themselves'),
  ('func',   'set_attendance',                       'ATTEND · staff mark by hand'),
  ('func',   'attendance_register',                  'ATTEND · today, marked and not'),
  ('func',   'rotate_attendance_code',               'ATTEND · reissue a shared card'),
  -- The evening lock is the feature. A mark_attendance() missing it would pass
  -- an existence check and let a student mark themselves at breakfast.
  ('body',   'mark_attendance|too_early',            'ATTEND · evening lock present'),
  ('body',   'mark_attendance|today_local',          'ATTEND · marks land on the local day'),
  -- Expected absences (patch 8b). The denominator, and the club that cancelled.
  ('table',  'attendance_absence',                   'AWAY · declared absences'),
  ('func',   'declare_absence',                      'AWAY · parent/student/staff declare'),
  ('func',   'cancel_absence',                       'AWAY · taking it back'),
  ('func',   'absent_on',                            'AWAY · is this student away today'),
  ('body',   'attendance_register|excused',          'AWAY · register knows the denominator'),
  -- The one that would silently ruin the feature: a mark_attendance() that
  -- refuses an excused student keeps them off the record, not off the bus.
  ('body',   'mark_attendance|marked_after_absence', 'AWAY · club cancelled, they ride anyway'),
  -- Bus monitors (patch 9). The students who account for riders without phones.
  ('column', 'students.has_phone',                   'MONITOR · who cannot self-scan'),
  ('column', 'students.is_monitor',                  'MONITOR · who answers for them'),
  ('func',   'monitor_assignments',                  'MONITOR · the round-robin split'),
  ('func',   'my_monitor_roster',                    'MONITOR · what one monitor sees'),
  ('func',   'monitor_mark',                         'MONITOR · confirming them aboard'),
  ('func',   'attendance_roll',                      'MONITOR · the staff view'),
  ('func',   'set_student_flags',                    'MONITOR · staff set both flags'),
  -- A monitor asked about a child whose parents already said they are not
  -- coming will either mark them wrongly present or report a false absence.
  ('body',   'monitor_assignments|attendance_absence','MONITOR · excludes expected absences'),
  -- Roster riders (patch 9c): students who will never sign in.
  ('func',   'staff_link_guardian',                  'ROSTER · office links the family'),
  ('func',   'student_guardians',                    'ROSTER · who is already linked'),
  ('func',   'all_parents',                          'ROSTER · the picker'),
  ('func',   'pending_links',                        'LINK · what is waiting'),
  ('func',   'reject_link',                          'LINK · turning one down'),
  -- Auto-accept (patch 9e). The trigger is the feature; the notification is
  -- what keeps it survivable, so a missing one is not a cosmetic loss.
  ('trigger','on_link_proposed',                     'LINK · accepted on insert'),
  ('trigger','on_link_accepted',                     'LINK · student and office told'),
  ('func',   'staff_unlink_guardian',                'LINK · the office can undo one')
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
      -- table|policy|needle. A policy's predicate is not a function body, so
      -- the 'body' check above cannot see it -- and an RLS policy left on the
      -- wrong date is invisible until a parent cannot see their van.
      when 'policy' then exists (
        select 1 from pg_policies
        where schemaname = 'public'
          and tablename  = split_part(e.name, '|', 1)
          and policyname = split_part(e.name, '|', 2)
          and coalesce(qual, '') like '%' || split_part(e.name, '|', 3) || '%')
      when 'body' then exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = split_part(e.name, '|', 1)
          and pg_get_functiondef(p.oid) like '%' || split_part(e.name, '|', 2) || '%')
      else false
    end as found
  from expected e
) x
order by found, label;
