-- Sample data for the pilot: one school, three vans, four neighbourhood hubs,
-- and a Morning / Afternoon / After-School Club route.
--
-- Run after schema.sql. Coordinates are around Cupertino, CA because that is
-- where the iOS simulator places itself by default.

update organization set name = 'CSW Student Transport' where id = 1;

insert into schools (id, name, address, lat, lng) values
  ('50000000-0000-0000-0000-000000000001', 'Cupertino High School',
   '10100 Finch Ave, Cupertino, CA', 37.3210, -122.0060);

-- ---------------------------------------------------------------------------
-- PLACEHOLDER HUBS -- replace these with the real ones.
--
-- Blueprint §3.1: hubs are agreed neighbourhood pickup points, reused across
-- routes -- not stops invented per route.
--
-- Two fields the families actually read:
--   name     short, and what appears on their screen        "Oak & Example"
--   address  the "which corner exactly" line                "Corner of Oak Road and Example Way"
--
-- The address is what stops someone waiting on the wrong side of the junction.
-- Fill it in even though it is optional.
--
-- Coordinates only matter once live GPS is switched on, so a rough pin is fine
-- for now -- long-press the spot in any maps app and copy the pair it shows.
-- These ones are around Cupertino, CA, because that is where the iOS simulator
-- places itself by default.
--
-- All of this is editable in the app: Setup -> Hubs. No SQL needed.
-- ---------------------------------------------------------------------------
insert into hubs (id, name, address, lat, lng) values
  ('40000000-0000-0000-0000-000000000001', 'Oak & Example',
   'Corner of Oak Road and Example Way (outside the clubhouse)',      37.3230, -122.0140),
  ('40000000-0000-0000-0000-000000000002', 'Maple & Second',
   'Corner of Maple Street and Second Avenue (by the post box)',      37.3382, -122.0180),
  ('40000000-0000-0000-0000-000000000003', 'Cedar Lot',
   'Cedar Avenue parking lot, north end',                             37.3349, -122.0090),
  ('40000000-0000-0000-0000-000000000004', 'Pine & Third',
   'Corner of Pine Boulevard and Third Street (bus shelter)',         37.3160, -122.0320);

insert into vehicles (id, label, plate, capacity) values
  ('11111111-1111-1111-1111-111111111111', 'Van 1', '7XYZ123', 16),
  ('22222222-2222-2222-2222-222222222222', 'Van 2', '8ABC456', 20),
  ('33333333-3333-3333-3333-333333333333', 'Van 3', '9DEF789', 12);

-- Blueprint §3.2: morning, afternoon, and club are SEPARATE routes. A student
-- can be on different ones (or on no club route at all).
insert into route_templates (id, name, type, school_id, operating_weekdays, default_vehicle_id) values
  ('a0000000-0000-0000-0000-000000000001', 'M-01 Morning',   'morning',   '50000000-0000-0000-0000-000000000001', '{1,2,3,4,5}', '11111111-1111-1111-1111-111111111111'),
  ('a0000000-0000-0000-0000-000000000002', 'A-01 Afternoon', 'afternoon', '50000000-0000-0000-0000-000000000001', '{1,2,3,4,5}', '11111111-1111-1111-1111-111111111111'),
  ('a0000000-0000-0000-0000-000000000003', 'C-01 Club',      'club',      '50000000-0000-0000-0000-000000000001', '{2,4}',       '33333333-3333-3333-3333-333333333333');

-- ---------------------------------------------------------------------------
-- PLACEHOLDER TIMES -- replace these with the real ones.
--
-- planned_arrival is when the van is DUE at that hub. It is what drives the
-- 15-minute and 5-minute alerts families get (blueprint §4.1), so it is the one
-- field worth getting right: a wrong time here means a child standing on a
-- corner too early, or missing the van.
--
-- planned_departure is when it leaves. On the school stop of a morning run only
-- the arrival matters; on the school stop of an afternoon run only the
-- departure does.
--
-- Leave a time blank and the app simply says "time not set" and schedules no
-- alerts for that hub -- it does not guess.
--
-- All editable in the app: Setup -> Routes -> (a route) -> Stops -> Times.
-- ---------------------------------------------------------------------------

-- Morning: hubs -> school.
insert into route_stops (id, route_id, seq, hub_id, school_id, planned_arrival, planned_departure) values
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 1, '40000000-0000-0000-0000-000000000001', null, '07:05', '07:10'),
  ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 2, '40000000-0000-0000-0000-000000000002', null, '07:18', '07:22'),
  ('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 3, '40000000-0000-0000-0000-000000000004', null, '07:30', '07:34'),
  ('b0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 4, null, '50000000-0000-0000-0000-000000000001', '07:50', null);

-- Afternoon: school -> hubs.
insert into route_stops (id, route_id, seq, hub_id, school_id, planned_arrival, planned_departure) values
  ('b0000000-0000-0000-0000-000000000011', 'a0000000-0000-0000-0000-000000000002', 1, null, '50000000-0000-0000-0000-000000000001', null, '15:20'),
  ('b0000000-0000-0000-0000-000000000012', 'a0000000-0000-0000-0000-000000000002', 2, '40000000-0000-0000-0000-000000000004', null, '15:38', '15:41'),
  ('b0000000-0000-0000-0000-000000000013', 'a0000000-0000-0000-0000-000000000002', 3, '40000000-0000-0000-0000-000000000002', null, '15:52', '15:55'),
  ('b0000000-0000-0000-0000-000000000014', 'a0000000-0000-0000-0000-000000000002', 4, '40000000-0000-0000-0000-000000000001', null, '16:05', null);

-- Club: later departure, only students approved as attending are seated.
insert into route_stops (id, route_id, seq, hub_id, school_id, planned_arrival, planned_departure) values
  ('b0000000-0000-0000-0000-000000000021', 'a0000000-0000-0000-0000-000000000003', 1, null, '50000000-0000-0000-0000-000000000001', null, '17:15'),
  ('b0000000-0000-0000-0000-000000000022', 'a0000000-0000-0000-0000-000000000003', 2, '40000000-0000-0000-0000-000000000003', null, '17:32', '17:35'),
  ('b0000000-0000-0000-0000-000000000023', 'a0000000-0000-0000-0000-000000000003', 3, '40000000-0000-0000-0000-000000000001', null, '17:45', null);

-- ---------------------------------------------------------------------------
-- The bootstrap invite
--
-- Signing up REQUIRES an invite code, and invites are issued by an admin — so
-- the first admin has nobody to invite them. This is that chicken-and-egg,
-- solved: one admin invite, created directly in the database, which is the only
-- place with the authority to do it.
--
-- Sign up in the app with this code. You become the administrator, and from then
-- on every other account (student, parent, driver, coordinator) is invited from
-- the portal.
--
-- It expires in 14 days like any other. If it lapses before you use it:
--   insert into invites (role, full_name, note)
--   values ('admin', 'Administrator', 'replacement bootstrap');
--   select code from invites where role = 'admin' order by created_at desc limit 1;
-- ---------------------------------------------------------------------------

insert into invites (code, role, full_name, note)
values ('BUS-ADMN-0001', 'admin', 'Administrator', 'Bootstrap invite — use this first.');

-- After running this file, look here for the codes you can hand out:
--   select code, role, full_name, expires_at from invites where used_at is null;
--
-- Device keys for the (currently disabled) GPS feature:
--   select v.label, d.device_key from vehicles v join vehicle_devices d on d.vehicle_id = v.id;
