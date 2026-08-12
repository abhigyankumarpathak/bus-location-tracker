-- ===========================================================================
-- A whole school day, end to end, asserting at every step.
--
-- DESTRUCTIVE. It truncates auth.users and seeds its own cast, so run it ONLY
-- against a scratch database — never the one with real families in it.
--
--   createdb bustest && psql bustest -f supabase/schema.sql
--   psql bustest -f supabase/patches/flow-test.sql
--
-- 36 assertions. Every line should read [PASS].
--
-- Runs the morning and the afternoon through the SAME calls the app makes, in
-- the same order, as the same roles. The point is to catch things that only
-- break when the pieces are combined — every guard was tested alone.
-- ===========================================================================
\set ON_ERROR_STOP off
\pset pager off
\timing off

create or replace function ok(label text, cond boolean) returns void
language plpgsql as $$
begin
  raise notice '%  %', case when cond then '[PASS]' else '[FAIL]' end, label;
end;
$$;

create or replace function as_user(u uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Cast
-- ---------------------------------------------------------------------------
alter table auth.users disable trigger on_auth_user_created;
truncate auth.users cascade;

insert into auth.users (id) values
 ('00000000-0000-0000-0000-0000000000d1'), -- Sam, driver
 ('00000000-0000-0000-0000-0000000000c1'), -- Cora, coordinator
 ('00000000-0000-0000-0000-000000000011'), -- Priya
 ('00000000-0000-0000-0000-000000000022'), -- Arun
 ('00000000-0000-0000-0000-000000000033'), -- Zoe
 ('00000000-0000-0000-0000-000000000044'), -- Ben
 ('00000000-0000-0000-0000-0000000000a1'), -- Mum (Priya + Arun)
 ('00000000-0000-0000-0000-0000000000a2'); -- Dad (Zoe)

insert into profiles (id, role, full_name, status) values
 ('00000000-0000-0000-0000-0000000000d1','driver','Sam Driver','active'),
 ('00000000-0000-0000-0000-0000000000c1','coordinator','Cora Coord','active'),
 ('00000000-0000-0000-0000-000000000011','student','Priya','active'),
 ('00000000-0000-0000-0000-000000000022','student','Arun','active'),
 ('00000000-0000-0000-0000-000000000033','student','Zoe','active'),
 ('00000000-0000-0000-0000-000000000044','student','Ben','active'),
 ('00000000-0000-0000-0000-0000000000a1','parent','Mum','active'),
 ('00000000-0000-0000-0000-0000000000a2','parent','Dad','active');

insert into students (student_id) select id from profiles where role = 'student';

insert into guardian_links (parent_id, student_id, status, requested_by) values
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000011','accepted','00000000-0000-0000-0000-0000000000a1'),
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000022','accepted','00000000-0000-0000-0000-0000000000a1'),
 ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000033','accepted','00000000-0000-0000-0000-0000000000a2');

insert into schools (id,name) values ('00000000-0000-0000-0000-00000000005c','Example School');
insert into hubs (id,name,lat,lng) values
 ('00000000-0000-0000-0000-0000000000b1','Oak Road',0,0),
 ('00000000-0000-0000-0000-0000000000b2','Elm Close',0,0);
insert into vehicles (id,label,capacity) values ('00000000-0000-0000-0000-000000000091','Van 1',16);

-- Morning: Oak Road -> Elm Close -> School.  Times are relative to NOW so the
-- watchdog and the arrival alerts see a realistic clock.
insert into route_templates (id,name,type,school_id,default_driver_id,default_vehicle_id,operating_weekdays) values
 ('00000000-0000-0000-0000-0000000000e1','Route 1 AM','morning','00000000-0000-0000-0000-00000000005c',
  '00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-000000000091', array[1,2,3,4,5,6,7]),
 ('00000000-0000-0000-0000-0000000000e2','Route 1 PM','afternoon','00000000-0000-0000-0000-00000000005c',
  '00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-000000000091', array[1,2,3,4,5,6,7]);

insert into route_stops (id,route_id,seq,hub_id,school_id,planned_arrival,planned_departure) values
 ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000e1',1,'00000000-0000-0000-0000-0000000000b1',null,(localtime + interval '12 min')::time,(localtime + interval '14 min')::time),
 ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000e1',2,'00000000-0000-0000-0000-0000000000b2',null,(localtime + interval '25 min')::time,(localtime + interval '27 min')::time),
 ('00000000-0000-0000-0000-0000000000f3','00000000-0000-0000-0000-0000000000e1',3,null,'00000000-0000-0000-0000-00000000005c',(localtime + interval '45 min')::time,null),
 -- Afternoon: School (ORIGIN, never "arrived at") -> Oak Road -> Elm Close.
 ('00000000-0000-0000-0000-0000000000fa','00000000-0000-0000-0000-0000000000e2',1,null,'00000000-0000-0000-0000-00000000005c',(localtime + interval '300 min')::time,(localtime + interval '302 min')::time),
 ('00000000-0000-0000-0000-0000000000fb','00000000-0000-0000-0000-0000000000e2',2,'00000000-0000-0000-0000-0000000000b1',null,(localtime + interval '320 min')::time,null),
 ('00000000-0000-0000-0000-0000000000fc','00000000-0000-0000-0000-0000000000e2',3,'00000000-0000-0000-0000-0000000000b2',null,(localtime + interval '335 min')::time,null);

-- Priya + Arun at Oak Road, Zoe + Ben at Elm Close.
insert into route_assignments (route_id, student_id, pickup_stop_id, dropoff_stop_id) values
 ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000f3'),
 ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-000000000022','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000f3'),
 ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-000000000033','00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000f3'),
 ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-000000000044','00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000f3'),
 ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-0000000000fa','00000000-0000-0000-0000-0000000000fb'),
 ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-000000000022','00000000-0000-0000-0000-0000000000fa','00000000-0000-0000-0000-0000000000fb'),
 ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-000000000033','00000000-0000-0000-0000-0000000000fa','00000000-0000-0000-0000-0000000000fc'),
 ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-000000000044','00000000-0000-0000-0000-0000000000fa','00000000-0000-0000-0000-0000000000fc');

\echo ''
\echo '################ 1. THE DAY IS GENERATED ################'
select as_user('00000000-0000-0000-0000-0000000000c1');
select ensure_daily_trips(current_date);
select ok('two trips exist for today', count(*) = 2) from daily_trips where date = current_date;
select ok('eight rider rows seeded', count(*) = 8) from student_trip_status;

\echo ''
\echo '################ 2. A PARENT REPORTS AN ABSENCE (S4) ################'
-- Ben is ill. The van has not started, so this must AUTO-APPROVE even though
-- the wall-clock cutoff has long passed.
select as_user('00000000-0000-0000-0000-0000000000a2');
insert into change_requests (student_id, date, kind, reason, requested_by)
values ('00000000-0000-0000-0000-000000000044', current_date, 'absent', 'Ill.',
        '00000000-0000-0000-0000-0000000000a2');
select ok('absence auto-approved before the van starts (S4)', approval = 'auto_approved')
from change_requests where student_id = '00000000-0000-0000-0000-000000000044';
select ok('Ben is now absent on the morning trip', sts.status = 'absent')
from student_trip_status sts join daily_trips t on t.id = sts.trip_id
where sts.student_id = '00000000-0000-0000-0000-000000000044' and t.route_id = '00000000-0000-0000-0000-0000000000e1';

\echo ''
\echo '################ 3. A STUDENT CHECKS IN (N2) ################'
select as_user('00000000-0000-0000-0000-000000000011');
update student_trip_status set status='waiting', check_in_time=now()
where student_id='00000000-0000-0000-0000-000000000011'
  and trip_id = (select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e1');
select ok('Priya checked in inside the window (N2)', sts.status = 'waiting')
from student_trip_status sts join daily_trips t on t.id=sts.trip_id
where sts.student_id='00000000-0000-0000-0000-000000000011' and t.route_id='00000000-0000-0000-0000-0000000000e1';

\echo ''
\echo '################ 4. ARRIVAL ALERTS (C6/N1) ################'
select as_user(null);
select send_arrival_alerts();
select ok('Mum got ONE alert naming both her children (N1)', count(*) = 1)
from notifications where kind='arrival' and user_id='00000000-0000-0000-0000-0000000000a1';
select ok('the alert names both', body is not null and title like '%and%')
from notifications where kind='arrival' and user_id='00000000-0000-0000-0000-0000000000a1';
select ok('absent Ben''s parent got nothing', count(*) = 0)
from notifications n where n.kind='arrival'
  and n.user_id in (select parent_id from guardian_links where student_id='00000000-0000-0000-0000-000000000044');

\echo ''
\echo '################ 5. THE DRIVER STARTS AND WORKS THE ROUTE ################'
select as_user('00000000-0000-0000-0000-0000000000d1');
update daily_trips set status='active', started_at=now()
where route_id='00000000-0000-0000-0000-0000000000e1';

-- Arrive at Oak Road.
insert into trip_stop_progress (trip_id, stop_id, arrived_at)
select id, '00000000-0000-0000-0000-0000000000f1', now() from daily_trips where route_id='00000000-0000-0000-0000-0000000000e1';

-- Board Priya only. Arun is still scheduled.
update student_trip_status set status='boarded', board_time=now()
where student_id='00000000-0000-0000-0000-000000000011'
  and trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e1');

\echo '-- C1: leaving with Arun unresolved must be REFUSED'
update trip_stop_progress set departed_at=now()
where stop_id='00000000-0000-0000-0000-0000000000f1';

select ok('C1 refused the departure (departed_at still null)', departed_at is null)
from trip_stop_progress where stop_id='00000000-0000-0000-0000-0000000000f1';

\echo '-- driver marks Arun a no-show, then leaves cleanly'
update student_trip_status set status='no_show'
where student_id='00000000-0000-0000-0000-000000000022'
  and trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e1');
update trip_stop_progress set departed_at=now(), skipped=false, departed_with_unresolved=false
where stop_id='00000000-0000-0000-0000-0000000000f1';
select ok('departure recorded once everyone had an outcome', departed_at is not null)
from trip_stop_progress where stop_id='00000000-0000-0000-0000-0000000000f1';

-- The app promotes boarded -> in_transit after the departure write.
update student_trip_status set status='in_transit'
where trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e1')
  and pickup_stop_id='00000000-0000-0000-0000-0000000000f1' and status='boarded';
select ok('Priya promoted to in_transit', status='in_transit')
from student_trip_status where student_id='00000000-0000-0000-0000-000000000011'
  and trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e1');
select ok('S7: Mum told the van left Oak Road', count(*) >= 1)
from notifications where kind='in_transit' and user_id='00000000-0000-0000-0000-0000000000a1';

\echo ''
\echo '################ 6. SECOND STOP: ALL AWAY -> SKIP ################'
-- Zoe is boarded normally; Ben is absent. Arrive and board Zoe.
insert into trip_stop_progress (trip_id, stop_id, arrived_at)
select id, '00000000-0000-0000-0000-0000000000f2', now() from daily_trips where route_id='00000000-0000-0000-0000-0000000000e1';
update student_trip_status set status='boarded', board_time=now()
where student_id='00000000-0000-0000-0000-000000000033'
  and trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e1');
update trip_stop_progress set departed_at=now()
where stop_id='00000000-0000-0000-0000-0000000000f2';
select ok('second stop departed (Ben absent does not block)', departed_at is not null)
from trip_stop_progress where stop_id='00000000-0000-0000-0000-0000000000f2';
update student_trip_status set status='in_transit'
where trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e1')
  and pickup_stop_id='00000000-0000-0000-0000-0000000000f2' and status='boarded';

\echo ''
\echo '################ 7. SCHOOL: BATCH DROP-OFF, THEN END TRIP ################'
insert into trip_stop_progress (trip_id, stop_id, arrived_at)
select id, '00000000-0000-0000-0000-0000000000f3', now() from daily_trips where route_id='00000000-0000-0000-0000-0000000000e1';
update student_trip_status set status='dropped_off', dropoff_time=now()
where trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e1')
  and status in ('boarded','in_transit');
select ok('two students dropped off at school', count(*) = 2)
from student_trip_status where status='dropped_off';

update daily_trips set status='completed', ended_at=now()
where route_id='00000000-0000-0000-0000-0000000000e1';
select ok('morning trip completed', status='completed')
from daily_trips where route_id='00000000-0000-0000-0000-0000000000e1';
select ok('dropped_off promoted to completed by the guard', count(*) = 2)
from student_trip_status sts join daily_trips t on t.id=sts.trip_id
where t.route_id='00000000-0000-0000-0000-0000000000e1' and sts.status='completed';

\echo ''
\echo '################ 8. WATCHDOG ON A CLEAN DAY ################'
select as_user(null);
select transport_watchdog();
select ok('no watchdog alert for the COMPLETED morning trip', count(*) = 0)
from watchdog_alerts a join daily_trips t on t.id=a.trip_id
where t.route_id='00000000-0000-0000-0000-0000000000e1' and a.resolved_at is null;
select ok('no false alarm on the afternoon school ORIGIN', count(*) = 0)
from watchdog_alerts where stop_id='00000000-0000-0000-0000-0000000000fa';

\echo ''
\echo '################ 9. AFTERNOON: C4 + C7 + C5 ################'
select as_user('00000000-0000-0000-0000-0000000000d1');
update daily_trips set status='active', started_at=now()
where route_id='00000000-0000-0000-0000-0000000000e2';

\echo '-- C4: Ben was marked absent this morning; on the PM trip he is scheduled.'
\echo '--     Mark him absent, then board him anyway with no note (must refuse).'
update student_trip_status set status='absent'
where student_id='00000000-0000-0000-0000-000000000044'
  and trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e2');
update student_trip_status set status='boarded'
where student_id='00000000-0000-0000-0000-000000000044'
  and trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e2');
select ok('C4 refused boarding an absent student with no note', status='absent')
from student_trip_status where student_id='00000000-0000-0000-0000-000000000044'
  and trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e2');

update student_trip_status set status='boarded', note='Turned up after all.', board_time=now()
where student_id='00000000-0000-0000-0000-000000000044'
  and trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e2');
select ok('C4 allowed it WITH a note', status='boarded')
from student_trip_status where student_id='00000000-0000-0000-0000-000000000044'
  and trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e2');
select ok('C4 told the coordinator, not just the parents', count(*) >= 1)
from notifications where kind='boarded_after_away' and user_id='00000000-0000-0000-0000-0000000000c1';

\echo '-- C8: a rider cannot jump straight to dropped_off'
update student_trip_status set status='dropped_off'
where student_id='00000000-0000-0000-0000-000000000033'
  and trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e2');
select ok('C8 refused scheduled -> dropped_off', status='scheduled')
from student_trip_status where student_id='00000000-0000-0000-0000-000000000033'
  and trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e2');

\echo '-- C5: mistap Zoe as no_show, then undo it'
update student_trip_status set status='no_show'
where student_id='00000000-0000-0000-0000-000000000033'
  and trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e2');
select undo_rider_status((select id from student_trip_status
  where student_id='00000000-0000-0000-0000-000000000033'
    and trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e2')));
select ok('C5 undo restored Zoe to scheduled', status='scheduled')
from student_trip_status where student_id='00000000-0000-0000-0000-000000000033'
  and trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e2');
select ok('C5 wrote a compensating audit entry', count(*) = 1)
from audit_logs where action='status_undo';

\echo '-- C7: the driver looks up a name'
select ok('C7 found Priya on today''s trips', count(*) >= 1)
from find_rider_today('Priya');
select ok('C7 marks her as MINE (same driver)', bool_or(is_mine))
from find_rider_today('Priya');

\echo ''
\echo '################ 10. S1: RUNNING LATE ################'
select report_delay((select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e2'), 20, 'Traffic.');
select ok('S1 recorded 20 minutes', delay_minutes = 20)
from daily_trips where route_id='00000000-0000-0000-0000-0000000000e2';
select ok('S1 told the families a NEW time', count(*) >= 1)
from notifications where kind='delay';

\echo ''
\echo '################ 11. THE SILENT FAILURE THE WATCHDOG EXISTS FOR ################'
-- The driver stops tapping. Push the trip start back so it overruns.
select as_user('00000000-0000-0000-0000-0000000000c1');
update daily_trips set started_at = now() - interval '4 hours'
where route_id='00000000-0000-0000-0000-0000000000e2';
select as_user(null);
select transport_watchdog();
select ok('watchdog noticed the trip that never ended', count(*) >= 1)
from watchdog_alerts where kind='trip_overrunning' and resolved_at is null;
select ok('watchdog told the coordinator', count(*) >= 1)
from notifications where kind='watchdog' and user_id='00000000-0000-0000-0000-0000000000c1';

\echo '-- and it does not repeat itself'
select count(*) as before_second_run from watchdog_alerts \gset
select transport_watchdog();
select ok('second sweep raised nothing new', count(*) = :before_second_run) from watchdog_alerts;

\echo ''
\echo '################ 12. END OF DAY ################'
select as_user('00000000-0000-0000-0000-0000000000c1');
update student_trip_status set status='dropped_off', dropoff_time=now()
where trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e2')
  and status in ('boarded','in_transit');
update student_trip_status set status='absent'
where trip_id=(select id from daily_trips where route_id='00000000-0000-0000-0000-0000000000e2')
  and status in ('scheduled','waiting');
update daily_trips set status='completed', ended_at=now()
where route_id='00000000-0000-0000-0000-0000000000e2';
select ok('afternoon trip completed', status='completed')
from daily_trips where route_id='00000000-0000-0000-0000-0000000000e2';

select transport_watchdog();
select ok('overrun alert cleared itself once the trip ended', count(*) = 0)
from watchdog_alerts where kind='trip_overrunning' and resolved_at is null;

\echo ''
\echo '################ 13. THE RECORD AFTERWARDS ################'
select ok('every rider ended with a final status', count(*) = 0)
from student_trip_status where status in ('scheduled','waiting','boarded','in_transit');
select ok('the audit log has the whole day', count(*) > 10) from audit_logs;
select ok('no notification is stuck unacknowledged and urgent', count(*) = 0)
from notifications where requires_ack and acknowledged_at is null
  and created_at < now() - interval '1 hour';
