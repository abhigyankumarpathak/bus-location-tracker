-- Student Transportation Platform — schema, RLS, triggers.
-- Follows the MVP Functional Blueprint (review draft).
--
-- Run once in the Supabase SQL Editor. It DROPS the app's tables first, so it is
-- safe to re-run while setting up and destructive afterwards.
--
-- SCOPE NOTE: the blueprint describes a multi-tenant SaaS where every record
-- carries a companyId. This build is for ONE organisation (one school transport
-- operation, three vans), so there is a single `organization` row instead of a
-- companyId on every table. If a second company is ever onboarded, that column
-- has to be added everywhere — it is the one thing here that does not scale by
-- accident.

-- Every table this file creates, or the re-run is not a re-run. A table left out
-- here survives the drop with its OLD columns (the cascade only removes its
-- foreign keys, not the table), and the create below then fails with "relation
-- already exists" — halfway through, leaving a half-built schema.
drop table if exists
  audit_logs, notifications, announcements, incidents, assignment_requests,
  change_requests, watchdog_alerts, arrival_alerts, trip_stop_progress, student_trip_status,
  daily_trips, route_assignments, route_stops, route_templates, invoices,
  vehicle_locations, vehicle_devices, vehicles, guardian_links, students, hubs,
  schools, account_removals, invites, profiles, organization cascade;

drop type if exists
  user_role, account_status, route_type, trip_status, rider_status,
  change_kind, approval_status, incident_kind, incident_severity,
  invoice_status, location_source, watchdog_kind cascade;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

-- Blueprint §2: Platform Super Admin is not used during a single-company pilot,
-- so it is omitted. Coordinator runs daily operations; admin also configures.
create type user_role as enum ('student', 'parent', 'driver', 'coordinator', 'admin');

-- Blueprint §6.1: "Create and deactivate users; assign roles."
--
-- Nobody self-selects a role. An admin creates the user, picks the role, and
-- hands out an invite code; signing up with that code is the ONLY way to get an
-- account. So a new user is `active` straight away — the vetting happened before
-- they ever reached the app. `pending` remains only for accounts an admin has
-- explicitly parked, and `suspended` for ones they have paused.
create type account_status as enum ('pending', 'active', 'suspended');

create type route_type as enum ('morning', 'afternoon', 'club', 'emergency');

create type trip_status as enum ('scheduled', 'active', 'completed', 'cancelled');

-- Blueprint §2.2. `waiting` is what a STUDENT can set — it means "I am at the
-- hub", NOT "I am on the bus". Only a driver sets boarded / dropped_off, which
-- is the official record. That distinction is the whole safety model: if a
-- student could self-report boarding, a child could be marked aboard a van they
-- never got on and nobody would go looking.
create type rider_status as enum (
  'scheduled',            -- planned on the trip (system)
  'waiting',              -- checked in at the hub (student / coordinator)
  'boarded',              -- driver confirmed entry (driver ONLY)
  'in_transit',           -- vehicle departed (driver / system)
  'dropped_off',          -- driver confirmed arrival (driver ONLY)
  'completed',            -- nothing further required (system)
  'absent',               -- did not travel
  'parent_pickup',        -- collected by a parent
  'no_show',              -- did not appear at the hub
  'unable_to_drop_off'    -- URGENT: still onboard, coordinator must resolve
);

create type change_kind as enum (
  'absent', 'parent_pickup', 'club_attending', 'club_cancelled', 'not_attending'
);

create type approval_status as enum ('auto_approved', 'pending', 'approved', 'rejected');

create type incident_kind as enum ('delay', 'breakdown', 'accident', 'behaviour', 'other');
create type incident_severity as enum ('low', 'medium', 'high');

create type invoice_status as enum ('unpaid', 'paid', 'waived');
create type location_source as enum ('driver_app', 'device');

-- The five things the watchdog can notice. Every one of them is a state the app
-- can reach in complete silence, because every other escalation here waits for
-- a driver to tap something.
create type watchdog_kind as enum (
  'trip_not_started',     -- the van should have left and the trip is untouched
  'stop_not_reached',     -- a stop with riders on it, long past its due time
  'rider_waiting',        -- a student said "I'm at the hub" and is still there
  'trip_overrunning',     -- active longer than any real route takes
  'rider_still_onboard',  -- the van finished its route with somebody still on it
  'urgent_unacknowledged' -- an URGENT notification nobody has said they saw
);

-- ---------------------------------------------------------------------------
-- Organisation + feature flags
-- ---------------------------------------------------------------------------

create table organization (
  id                 int primary key default 1 check (id = 1),
  name               text not null default 'School Transport',
  logo_url           text,

  -- Live vehicle tracking. Blueprint §1.2 and §8 keep it out of the first
  -- release until cost and battery have been measured, so it ships OFF -- but
  -- it is wired end to end, not stubbed: turning this on starts the driver
  -- phone reporting on trip start and puts the van on the parent and student
  -- maps. Position comes from the driver's phone today; the ingest-location
  -- endpoint takes the same rows from a hardware tracker in the van when one is
  -- fitted, and nothing above this line has to change when it is.
  gps_enabled        boolean not null default false,

  -- Blueprint §1.2 excludes payments/invoicing. Same story: built, switched off.
  payments_enabled   boolean not null default false,

  -- Blueprint §4.2: changes before the cutoff are automatic; later ones need a
  -- coordinator to approve them.
  morning_cutoff     time not null default '06:30',
  afternoon_cutoff   time not null default '13:30',

  -- Blueprint §4.1: check-in is only allowed within a window before the trip.
  checkin_window_min int not null default 60,

  -- How riders are marked on board.
  --   'manual' — the driver taps each student by name. The default.
  --   'scan'   — the student shows a QR code and the DRIVER scans it, on both
  --              legs of the day. Faster, and it cannot board the wrong child.
  --              Manual stays available underneath it: a flat phone has no QR,
  --              and the van still has to leave.
  attendance_mode text not null default 'manual' check (attendance_mode in ('manual', 'scan')),

  -- The watchdog (see transport_watchdog further down).
  --
  -- Every other escalation in this system is driven by a driver TAP. If the
  -- phone dies, is pocketed, or the driver simply stops tapping, the trip stays
  -- `active` for ever and nobody is told anything. These are the thresholds for
  -- the one thing that watches the clock instead of waiting to be told.
  --
  -- They live here rather than in the function because the right number is an
  -- operational question, not an engineering one -- a rural route with a 40
  -- minute gap between hubs needs different patience from a town run, and
  -- finding that out should not need a migration.
  watchdog_enabled          boolean not null default true,
  -- Trip still `scheduled` this long after the first stop's planned departure.
  watchdog_trip_start_min   int not null default 10 check (watchdog_trip_start_min > 0),
  -- Stop with riders on it not marked arrived this long after planned arrival.
  watchdog_stop_arrival_min int not null default 15 check (watchdog_stop_arrival_min > 0),
  -- A student sat on `waiting` -- "I am at the hub" -- for this long.
  watchdog_waiting_min      int not null default 20 check (watchdog_waiting_min > 0),
  -- A trip `active` for longer than any real route takes.
  watchdog_trip_max_min     int not null default 120 check (watchdog_trip_max_min > 0),
  -- A rider still on board this long after the van reached its final stop.
  watchdog_onboard_min      int not null default 15 check (watchdog_onboard_min > 0),

  -- How long a driver has to take back a mistap. This is a phone held one-handed
  -- in a moving vehicle by someone also responsible for children; mistaps are
  -- not an edge case. Long enough to notice, short enough that it is still an
  -- undo rather than a rewrite of history.
  undo_window_sec int not null default 90 check (undo_window_sec > 0)
);

insert into organization (id) values (1);

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

create table profiles (
  id              uuid primary key references auth.users on delete cascade,
  role            user_role not null,
  full_name       text not null default '',
  email           text,
  phone           text,
  status          account_status not null default 'pending',
  expo_push_token text,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Invites (blueprint §6.1)
--
--   Admin creates user → user receives code → user signs up → role is assigned
--
-- The invite is what carries the role. A person signing up cannot choose or
-- influence it: the signup trigger reads the role off the invite row, ignores
-- anything the client sent, and refuses outright if the code is missing,
-- unknown, already used, revoked, or expired.
--
-- This is why there is no approval queue any more. The admin already decided who
-- this person is and what they are, before the code was ever handed out.
-- ---------------------------------------------------------------------------
create table invites (
  id         uuid primary key default gen_random_uuid(),
  -- Short, human-readable, and unambiguous when read aloud or typed by a parent:
  -- no O/0 or I/1 confusion. Generated by new_invite_code() below.
  code       text unique not null,
  role       user_role not null,
  full_name  text not null default '',
  -- Optional. If set, only that address may redeem the code.
  email      text,
  note       text,
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days'),
  used_by    uuid references profiles on delete set null,
  used_at    timestamptz,
  revoked_at timestamptz
);
create index invites_code_idx on invites (upper(code));

create table schools (
  id      uuid primary key default gen_random_uuid(),
  name    text not null,
  address text,
  lat     double precision,
  lng     double precision
);

-- Blueprint §3.1: a hub is an agreed neighbourhood pickup point — a clubhouse,
-- a parking area. Hubs are reusable across routes, unlike the ad-hoc stops this
-- app had before.
create table hubs (
  id      uuid primary key default gen_random_uuid(),
  name    text not null,
  address text,
  lat     double precision not null,
  lng     double precision not null,
  active  boolean not null default true
);

-- Extends a student profile.
create table students (
  student_id        uuid primary key references profiles on delete cascade,
  school_id         uuid references schools on delete set null,
  grade             text,
  morning_hub_id    uuid references hubs on delete set null,
  afternoon_hub_id  uuid references hubs on delete set null
);

create table guardian_links (
  id           uuid primary key default gen_random_uuid(),
  parent_id    uuid not null references profiles on delete cascade,
  student_id   uuid not null references profiles on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted')),
  requested_by uuid not null references profiles on delete cascade,
  created_at   timestamptz not null default now(),
  unique (parent_id, student_id)
);

-- ---------------------------------------------------------------------------
-- Fleet
-- ---------------------------------------------------------------------------

create table vehicles (
  id       uuid primary key default gen_random_uuid(),
  label    text not null,
  plate    text,
  capacity int not null default 20,
  active   boolean not null default true
);

-- GPS tracker secret, in its own table because `vehicles` is readable by every
-- signed-in user and RLS is row-level, not column-level. Unused while
-- gps_enabled is false.
create table vehicle_devices (
  vehicle_id uuid primary key references vehicles on delete cascade,
  device_key text unique not null default encode(gen_random_bytes(24), 'hex')
);

create or replace function add_vehicle_device() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into vehicle_devices (vehicle_id) values (new.id);
  return new;
end;
$$;

create trigger on_vehicle_created after insert on vehicles
  for each row execute function add_vehicle_device();

-- ---------------------------------------------------------------------------
-- Routing (blueprint §3: templates, from which daily trips are generated)
-- ---------------------------------------------------------------------------

create table route_templates (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  type               route_type not null,
  school_id          uuid references schools on delete set null,
  -- ISO weekdays: 1 = Monday … 7 = Sunday.
  operating_weekdays int[] not null default '{1,2,3,4,5}',
  default_driver_id  uuid references profiles on delete set null,
  default_vehicle_id uuid references vehicles on delete set null,
  active             boolean not null default true,
  created_at         timestamptz not null default now()
);

-- An ordered list of hubs and school stops. Exactly one of hub_id / school_id.
create table route_stops (
  id                 uuid primary key default gen_random_uuid(),
  route_id           uuid not null references route_templates on delete cascade,
  seq                int not null default 0,
  hub_id             uuid references hubs on delete cascade,
  school_id          uuid references schools on delete cascade,
  planned_arrival    time,
  planned_departure  time,
  check (num_nonnulls(hub_id, school_id) = 1)
);
create index route_stops_route_idx on route_stops (route_id, seq);

create table route_assignments (
  id              uuid primary key default gen_random_uuid(),
  route_id        uuid not null references route_templates on delete cascade,
  student_id      uuid not null references profiles on delete cascade,
  pickup_stop_id  uuid references route_stops on delete set null,
  dropoff_stop_id uuid references route_stops on delete set null,
  unique (route_id, student_id)
);

-- ---------------------------------------------------------------------------
-- Daily operations
-- ---------------------------------------------------------------------------

create table daily_trips (
  id            uuid primary key default gen_random_uuid(),
  route_id      uuid not null references route_templates on delete cascade,
  date          date not null default current_date,
  driver_id     uuid references profiles on delete set null,
  vehicle_id    uuid references vehicles on delete set null,
  status        trip_status not null default 'scheduled',
  started_at    timestamptz,
  ended_at      timestamptz,
  delay_minutes int,
  delay_reason  text,
  unique (route_id, date)
);
create index daily_trips_date_idx on daily_trips (date, status);

-- A short, URL-safe, unguessable token. Defined here rather than with the other
-- functions further down because student_trip_status DEFAULTs a column to it,
-- and a default cannot reference a function that does not exist yet.
create or replace function new_boarding_code() returns text
language sql volatile as $$
  select translate(encode(gen_random_bytes(12), 'base64'), '+/=', '-_');
$$;

create table student_trip_status (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references daily_trips on delete cascade,
  student_id    uuid not null references profiles on delete cascade,
  status        rider_status not null default 'scheduled',
  pickup_stop_id  uuid references route_stops on delete set null,
  dropoff_stop_id uuid references route_stops on delete set null,
  check_in_time timestamptz,
  board_time    timestamptz,
  dropoff_time  timestamptz,
  note          text,

  -- The token behind the student's QR code, when attendance_mode = 'scan'.
  --
  -- Per TRIP ROW, not per student, so it changes every day and for every leg. A
  -- screenshot of yesterday's code is worthless, and a code scanned off a
  -- classmate's phone identifies THAT classmate — the driver sees the wrong name
  -- and stops. It never leaves the row: the student reads their own, the driver
  -- reads the ones on their trip, and RLS says nobody else.
  boarding_code text not null default new_boarding_code(),

  updated_by    uuid references profiles on delete set null,
  updated_at    timestamptz not null default now(),
  unique (trip_id, student_id)
);
create index sts_trip_idx on student_trip_status (trip_id);
create index sts_student_idx on student_trip_status (student_id);

-- The van's actual progress through a trip, stop by stop. One row per stop the
-- driver reaches, holding when they got there and when they pulled away. This is
-- per-day and per-stop, so it cannot live on route_stops (the shared template)
-- or daily_trips (one row per trip). The driver writes it; staff, and the
-- riders/parents on the trip, read it -- which is how a parent learns "the van
-- has arrived at your hub".
create table trip_stop_progress (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references daily_trips on delete cascade,
  stop_id     uuid not null references route_stops on delete cascade,
  arrived_at  timestamptz,
  departed_at timestamptz,

  -- The driver left this stop with somebody still unaccounted for. The database
  -- refuses that write unless this is set (see guard_stop_departure), because a
  -- van pulling away from a child who tapped "I'm at the hub" used to be
  -- completely silent -- the catch was End trip, potentially forty minutes and
  -- eight stops later. It is still ALLOWED: a driver must always be able to keep
  -- driving. It just costs an incident and a notification instead of nothing.
  departed_with_unresolved boolean not null default false,

  -- Nobody was due here today, so the van never stopped. Explicit rather than
  -- inferred from a null arrived_at, which cannot tell "deliberately skipped"
  -- apart from "the arrival was never recorded".
  skipped     boolean not null default false,

  unique (trip_id, stop_id),

  -- A van cannot leave before it got there. Enforced as well as guarded, so it
  -- holds for anything writing this table directly.
  constraint stop_progress_ordering
    check (departed_at is null or arrived_at is null or departed_at >= arrived_at),
  constraint stop_progress_skipped_not_served
    check (not skipped or arrived_at is null)
);
create index trip_stop_progress_trip_idx on trip_stop_progress (trip_id);


-- Which "the van is nearly here" alerts have already gone out.
--
-- Keyed on the STOP, not the student: two children at the same hub used to get
-- two near-identical notifications at the same second, which is how a family
-- learns to swipe them away without reading. One alert per hub per milestone,
-- naming whoever it covers.
create table arrival_alerts (
  id       uuid primary key default gen_random_uuid(),
  trip_id  uuid not null references daily_trips on delete cascade,
  stop_id  uuid not null references route_stops on delete cascade,
  minutes  int not null,
  sent_at  timestamptz not null default now(),
  unique (trip_id, stop_id, minutes)
);

-- Blueprint §4.2 / §6.3. A parent (or student, for club) asks for a change.
-- Before the cutoff it applies immediately; after it, a coordinator decides.
create table change_requests (
  id               uuid primary key default gen_random_uuid(),
  student_id       uuid not null references profiles on delete cascade,
  date             date not null,

  -- The last day the change covers, for a holiday or a long illness. Null means
  -- a single day, which is what almost every request is -- so the column is
  -- nullable rather than defaulted, and every query reads it as
  -- `coalesce(end_date, date)`. Without this a month away was twenty separate
  -- submissions, each one its own chance to typo a date or miss a cutoff.
  end_date         date check (end_date is null or end_date >= date),

  kind             change_kind not null,
  reason           text,
  requested_by     uuid references profiles on delete set null,
  approval         approval_status not null default 'pending',
  reviewed_by      uuid references profiles on delete set null,
  reviewed_at      timestamptz,
  review_note      text,
  created_at       timestamptz not null default now()
);
create index change_requests_open_idx on change_requests (date, approval);
create index change_requests_span_idx on change_requests (student_id, date, end_date);

-- A parent's request to change WHERE their child rides from: the morning and
-- afternoon hubs and the school. Unlike change_requests (a one-day exception),
-- this changes the student's standing assignment, so it always needs a person to
-- approve it -- there is no cutoff and no auto-approval. The row holds the whole
-- desired assignment, prefilled from the current one, so approving it applies all
-- three fields at once regardless of which the parent actually touched. The
-- office still decides which route/bus serves a hub; this only moves the child to
-- a different hub, which is how they end up on a different bus.
create table assignment_requests (
  id               uuid primary key default gen_random_uuid(),
  student_id       uuid not null references profiles on delete cascade,
  requested_by     uuid references profiles on delete set null,
  school_id        uuid references schools on delete set null,
  morning_hub_id   uuid references hubs on delete set null,
  afternoon_hub_id uuid references hubs on delete set null,
  reason           text,
  status           approval_status not null default 'pending',
  reviewed_by      uuid references profiles on delete set null,
  reviewed_at      timestamptz,
  review_note      text,
  created_at       timestamptz not null default now()
);
create index assignment_requests_open_idx on assignment_requests (status, created_at);

create table incidents (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid references daily_trips on delete cascade,
  student_id  uuid references profiles on delete set null,
  driver_id   uuid references profiles on delete set null,
  kind        incident_kind not null,
  severity    incident_severity not null default 'low',
  description text,
  resolved_at timestamptz,
  resolved_by uuid references profiles on delete set null,
  created_at  timestamptz not null default now()
);

create table announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  body       text not null,
  -- Who it is for. Both null means everybody, which is now a choice the sender
  -- makes rather than the only thing the system could do (N5).
  route_id   uuid references route_templates on delete cascade,
  student_id uuid references profiles on delete cascade,
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now()
);

create table notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles on delete cascade,
  title      text not null,
  body       text not null,
  kind       text not null default 'info',
  read_at    timestamptz,
  created_at timestamptz not null default now(),

  -- S6: push had NO delivery guarantee and no record. `send-push` returned early
  -- when a profile had no token — no row, no retry, no fallback — and the in-app
  -- inbox was the backstop, which needs the app opened. For "URGENT — could not
  -- drop off", that is not a delivery mechanism, it is a hope.
  delivery_state   text not null default 'pending'
    check (delivery_state in ('pending', 'sent', 'no_token', 'failed')),
  delivery_detail  text,
  delivered_at     timestamptz,

  -- The two urgent kinds are not "delivered" until a person has said they saw
  -- them. Everything else is fire-and-forget on purpose.
  requires_ack     boolean not null default false,
  acknowledged_at  timestamptz,
  acknowledged_by  uuid references profiles on delete set null
);
create index notifications_user_idx on notifications (user_id, created_at desc);
create index notifications_unacked_idx on notifications (requires_ack, acknowledged_at)
  where requires_ack and acknowledged_at is null;

-- Which notification kinds a human has to actually acknowledge.
create or replace function set_notification_ack() returns trigger
language plpgsql set search_path = public as $$
begin
  new.requires_ack := new.kind in ('unable_to_drop_off', 'no_show_after_checkin');
  return new;
end;
$$;

create trigger on_notification_created before insert on notifications
  for each row execute function set_notification_ack();

-- Blueprint §2.1: "Only coordinators and administrators may override an official
-- status, and a reason is required." This is where that reason lives.
create table audit_logs (
  id          uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id   uuid,
  action      text not null,
  old_value   jsonb,
  new_value   jsonb,
  reason      text,
  changed_by  uuid references profiles on delete set null,
  changed_at  timestamptz not null default now()
);
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id, changed_at desc);

-- What the watchdog has noticed and not yet been told is fine.
--
-- The dedupe key below is the whole point: pg_cron runs this every five minutes,
-- and a stop that is twenty minutes late is still late on the next pass. Without
-- it, one breach becomes an alert every five minutes until someone acts, which
-- is how a coordinator learns to ignore the queue.
create table watchdog_alerts (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid references daily_trips on delete cascade,
  stop_id     uuid references route_stops on delete set null,
  student_id  uuid references profiles on delete cascade,
  -- Set only for `urgent_unacknowledged`, where the subject is a MESSAGE nobody
  -- answered rather than a trip, a stop or a child.
  notification_id uuid references notifications on delete cascade,
  kind        watchdog_kind not null,
  detail      text not null,
  raised_at   timestamptz not null default now(),
  -- Set once the coordinator has been told. Separate from raised_at so raising
  -- and notifying are independent -- a failed notification insert cannot lose
  -- the alert, and a re-run picks up anything unnotified.
  notified_at timestamptz,
  -- Cleared either by a coordinator, or by the watchdog itself when the
  -- underlying condition goes away (the van finally arrives, the child boards).
  -- Without the self-clearing half, the queue fills with alerts about things
  -- that resolved themselves and stops being worth looking at.
  resolved_at timestamptz,
  resolved_by uuid references profiles on delete set null,
  resolution  text
);

-- One open alert per (kind, trip, stop, student). Written as an expression index
-- because a plain unique constraint treats NULLs as distinct, so `(trip, null,
-- null, 'trip_not_started')` would happily insert on every single pass.
create unique index watchdog_alerts_once on watchdog_alerts (
  kind,
  coalesce(trip_id,         '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(stop_id,         '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(student_id,      '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(notification_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
create index watchdog_alerts_open_idx on watchdog_alerts (resolved_at, raised_at desc);

-- ---------------------------------------------------------------------------
-- Switched-off features (built, gated — see organization flags)
-- ---------------------------------------------------------------------------

create table vehicle_locations (
  id          bigserial primary key,
  vehicle_id  uuid not null references vehicles on delete cascade,
  trip_id     uuid references daily_trips on delete set null,
  lat         double precision not null,
  lng         double precision not null,
  heading     double precision,
  speed       double precision,
  source      location_source not null default 'driver_app',
  recorded_at timestamptz not null default now()
);
create index vehicle_locations_vehicle_idx on vehicle_locations (vehicle_id, recorded_at desc);

create table invoices (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references profiles on delete cascade,
  period       text not null,
  amount_cents int not null,
  due_date     date not null,
  status       invoice_status not null default 'unpaid',
  paid_at      timestamptz,
  note         text,
  unique (student_id, period)
);

create table account_removals (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  reason     text not null,
  removed_by uuid references profiles on delete set null,
  created_at timestamptz not null default now()
);
create index account_removals_email_idx on account_removals (lower(email));

-- ---------------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER so policies can read profiles without
-- recursing into the profiles policies)
-- ---------------------------------------------------------------------------

create or replace function my_role() returns user_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and status = 'active';
$$;

/**
 * Is the caller's account live?
 *
 * Every data policy below is gated on this. Without it, suspending an account
 * would only stop them at the UI: their session keeps working, `auth.uid()` is
 * still their id, and a policy that says `student_id = auth.uid()` happily keeps
 * serving them their own trips through a raw API call. Suspension has to bite at
 * the database or it is theatre.
 *
 * The two deliberate exceptions are the "read own profile" and "update own
 * profile" policies — a blocked user still has to be able to load the screen
 * that tells them they are blocked.
 */
create or replace function is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and status = 'active');
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(my_role() = 'admin', false);
$$;

-- Coordinators run daily operations; admins can do everything a coordinator can.
create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(my_role() in ('coordinator', 'admin'), false);
$$;

create or replace function is_guardian_of(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from guardian_links
    where parent_id = auth.uid() and student_id = target and status = 'accepted'
  );
$$;

/**
 * Is `parent` a guardian of `child`? The explicit two-argument form.
 *
 * `is_guardian_of(target)` asks about the CALLER, which is what every RLS policy
 * needs. The announcement fan-out is asking about somebody else entirely, from
 * inside a security-definer trigger where auth.uid() is the poster.
 */
create or replace function is_guardian_of_by(parent uuid, child uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from guardian_links
    where parent_id = parent and student_id = child and status = 'accepted'
  );
$$;

create or replace function is_child_of(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from guardian_links
    where student_id = auth.uid() and parent_id = target and status = 'accepted'
  );
$$;

-- Blueprint §2: "Drivers must never see routes that are not assigned to them."
-- Gated on is_active() so suspending a driver mid-route actually cuts them off,
-- rather than only hiding the screens from them.
/**
 * Is it a sensible time for this student to say "I'm at the hub"?
 *
 * Blueprint §4.1 puts check-in inside a window before the trip.
 * `checkin_window_min` has always existed to express that and has never been
 * checked anywhere — so a student could tap it at 3am and the driver would find
 * a `waiting` flag eight hours stale.
 *
 * Opens `checkin_window_min` before the planned arrival and closes half an hour
 * after it, which covers a late van without leaving the flag settable all day. A
 * stop with no planned time has no window to enforce, so it stays open.
 */
create or replace function within_checkin_window(target_trip uuid, target_stop uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from daily_trips t
    left join route_stops rs on rs.id = target_stop
    cross join organization o
    where t.id = target_trip
      and o.id = 1
      and t.date = current_date
      and (
        rs.planned_arrival is null
        or now() between (t.date + rs.planned_arrival)::timestamptz
                         - make_interval(mins => o.checkin_window_min)
                     and (t.date + rs.planned_arrival)::timestamptz + interval '30 min'
      )
  );
$$;

create or replace function drives_trip(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_active()
     and exists (select 1 from daily_trips where id = target and driver_id = auth.uid());
$$;

-- Is this student on one of the caller's trips today?
create or replace function drives_student(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_active() and exists (
    select 1
    from student_trip_status sts
    join daily_trips t on t.id = sts.trip_id
    where sts.student_id = target
      and t.driver_id = auth.uid()
      and t.date = current_date
  );
$$;

create or replace function find_user_by_contact(contact text)
returns table (id uuid, full_name text, role user_role)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.role
  from profiles p
  where p.status = 'active'
    and p.id <> auth.uid()
    and (
      lower(p.email) = lower(trim(contact))
      or (
        regexp_replace(trim(contact), '\D', '', 'g') <> ''
        and regexp_replace(coalesce(p.phone, ''), '\D', '', 'g')
            = regexp_replace(trim(contact), '\D', '', 'g')
      )
    )
  limit 1;
$$;

/**
 * Who is on the other side of your guardian links — including PENDING ones.
 *
 * profiles RLS lets a parent and a child read each other only once the link is
 * `accepted` (is_guardian_of and is_child_of both insist on it). That is the
 * right rule for the profiles table, and the wrong one for a consent prompt: it
 * left both sides of a pending request looking at "Unknown". The parent could
 * not see who they had asked, and the student could not see who was asking —
 * and a request you cannot put a name to is not one anybody should accept.
 *
 * So: names for people you already have a link row with, either direction,
 * pending or accepted. The phone number is withheld until the link IS accepted,
 * because that is the part the other person has not agreed to share yet. Nothing
 * here is reachable without a link row, and creating one already requires
 * knowing the person's exact email or phone.
 */
create or replace function my_link_counterparts()
returns table (id uuid, full_name text, role user_role, phone text)
language sql stable security definer set search_path = public as $$
  select p.id,
         p.full_name,
         p.role,
         case when gl.status = 'accepted' then p.phone end
  from guardian_links gl
  join profiles p
    on p.id = case when gl.parent_id = auth.uid() then gl.student_id else gl.parent_id end
  where gl.parent_id = auth.uid() or gl.student_id = auth.uid();
$$;
grant execute on function my_link_counterparts() to authenticated;

create or replace function removal_notice_for(target_email text) returns text
language sql stable security definer set search_path = public as $$
  select reason from account_removals
  where lower(email) = lower(trim(target_email))
  order by created_at desc limit 1;
$$;
grant execute on function removal_notice_for(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Signup by invite
--
--   Admin creates user → user receives code → user signs up → role is assigned
-- ---------------------------------------------------------------------------

-- Codes are read aloud, texted, and typed by parents. Crockford-ish alphabet:
-- no O/0, no I/1, no U. Format BUS-XXXX-XXXX.
create or replace function new_invite_code() returns text
language plpgsql volatile set search_path = public as $$
declare
  alphabet text := '23456789ABCDEFGHJKLMNPQRSTVWXYZ';
  candidate text;
  i int;
begin
  loop
    candidate := 'BUS-';
    for i in 1..8 loop
      if i = 5 then candidate := candidate || '-'; end if;
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from invites where code = candidate);
  end loop;
  return candidate;
end;
$$;

create or replace function set_invite_code() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.code is null or new.code = '' then
    new.code := new_invite_code();
  end if;
  new.code := upper(trim(new.code));
  return new;
end;
$$;

create trigger on_invite_created before insert on invites
  for each row execute function set_invite_code();

/**
 * What a code is for, checked BEFORE the person creates an account.
 *
 * Callable while signed out — it has to be; the whole point is that the user has
 * no account yet. It reveals only what the invite already told them (their name
 * and the role the admin chose), and only for a code they already hold. It does
 * not reveal whether an unrelated code exists, beyond the yes/no that redeeming
 * would give away anyway.
 */
create or replace function invite_details(invite_code text)
returns table (role user_role, full_name text, email text, valid boolean, reason text)
language plpgsql stable security definer set search_path = public as $$
declare
  inv invites%rowtype;
begin
  select * into inv from invites where upper(code) = upper(trim(invite_code));

  if not found then
    return query select null::user_role, ''::text, null::text, false,
                        'That invite code is not recognised.'::text;
  elsif inv.revoked_at is not null then
    return query select inv.role, inv.full_name, inv.email, false,
                        'That invite has been withdrawn. Ask the transport office for a new one.'::text;
  elsif inv.used_at is not null then
    return query select inv.role, inv.full_name, inv.email, false,
                        'That invite has already been used.'::text;
  elsif inv.expires_at < now() then
    return query select inv.role, inv.full_name, inv.email, false,
                        'That invite has expired. Ask the transport office for a new one.'::text;
  else
    return query select inv.role, inv.full_name, inv.email, true, null::text;
  end if;
end;
$$;

grant execute on function invite_details(text) to anon, authenticated;

/**
 * The only way an account comes into existence.
 *
 * The role is taken from the INVITE, never from what the client sent. A signup
 * with no code, a bad code, a used code, or an expired code does not create a
 * half-account — it raises, and Supabase rolls the auth user back with it.
 */
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  supplied text := upper(trim(coalesce(new.raw_user_meta_data ->> 'invite_code', '')));
  inv invites%rowtype;
begin
  if supplied = '' then
    raise exception 'An invite code is required. Ask the transport office to invite you.';
  end if;

  select * into inv from invites where upper(code) = supplied for update;

  if not found then
    raise exception 'That invite code is not recognised.';
  end if;
  if inv.revoked_at is not null then
    raise exception 'That invite has been withdrawn.';
  end if;
  if inv.used_at is not null then
    raise exception 'That invite has already been used.';
  end if;
  if inv.expires_at < now() then
    raise exception 'That invite has expired.';
  end if;
  -- An invite addressed to one person cannot be redeemed by another.
  if inv.email is not null and lower(inv.email) <> lower(new.email) then
    raise exception 'That invite was issued to a different email address.';
  end if;

  insert into profiles (id, role, full_name, email, phone, status)
  values (
    new.id,
    inv.role,                                   -- from the invite. Not negotiable.
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), inv.full_name, ''),
    new.email,
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    'active'                                    -- the admin already vetted them
  );

  if inv.role = 'student' then
    insert into students (student_id) values (new.id);
  end if;

  update invites set used_by = new.id, used_at = now() where id = inv.id;

  insert into notifications (user_id, title, body, kind)
  select p.id,
         'Invite redeemed',
         coalesce(nullif(inv.full_name, ''), new.email) || ' has joined as a ' || inv.role || '.',
         'account'
  from profiles p where p.role in ('coordinator', 'admin') and p.status = 'active';

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- Nobody may change their own role or status. Without this, the "update own
-- profile" policy would let a pending user approve themselves.
create or replace function guard_privileged_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or is_admin() then
    return new;
  end if;
  if new.role is distinct from old.role then
    raise exception 'Only an administrator may change an account role.';
  end if;
  if new.status is distinct from old.status then
    raise exception 'Only an administrator may change an account status.';
  end if;
  return new;
end;
$$;

create trigger on_profile_privileged_update before update on profiles
  for each row execute function guard_privileged_columns();

-- ---------------------------------------------------------------------------
-- Daily trip generation (blueprint §3: "the system creates daily trips from the
-- appropriate templates")
-- ---------------------------------------------------------------------------

-- Idempotent. Creates the day's trips from every active template that runs on
-- that weekday, then seats every assigned student — minus anyone with an
-- approved absence or parent-pickup for that date, and (for club routes) anyone
-- who has not been approved as attending.
create or replace function ensure_daily_trips(target_date date default current_date)
returns int
language plpgsql security definer set search_path = public as $$
declare
  created int := 0;
  tpl record;
  -- Prefixed because an unprefixed `trip_id` would be ambiguous against the
  -- column of the same name inside the INSERT below.
  v_trip_id uuid;
begin
  for tpl in
    select * from route_templates
    where active
      and extract(isodow from target_date)::int = any (operating_weekdays)
  loop
    insert into daily_trips (route_id, date, driver_id, vehicle_id, status)
    values (tpl.id, target_date, tpl.default_driver_id, tpl.default_vehicle_id, 'scheduled')
    on conflict (route_id, date) do nothing
    returning id into v_trip_id;

    if v_trip_id is null then
      select id into v_trip_id from daily_trips
      where route_id = tpl.id and date = target_date;
    else
      created := created + 1;
    end if;

    insert into student_trip_status (trip_id, student_id, status, pickup_stop_id, dropoff_stop_id)
    select
      v_trip_id,
      ra.student_id,
      case
        when cr.kind = 'absent'        then 'absent'::rider_status
        when cr.kind = 'parent_pickup' then 'parent_pickup'::rider_status
        else 'scheduled'::rider_status
      end,
      ra.pickup_stop_id,
      ra.dropoff_stop_id
    from route_assignments ra
    -- A request covers `date`..`end_date`, so a holiday booked once keeps
    -- seating the student as Absent every day it spans. Null end_date is the
    -- ordinary single-day case.
    left join lateral (
      select kind from change_requests c
      where c.student_id = ra.student_id
        and target_date between c.date and coalesce(c.end_date, c.date)
        and c.approval in ('auto_approved', 'approved')
        and c.kind in ('absent', 'parent_pickup')
      order by c.created_at desc limit 1
    ) cr on true
    where ra.route_id = tpl.id
      -- Blueprint §3.2: "Only students attending the club are included."
      and (
        tpl.type <> 'club'
        or exists (
          select 1 from change_requests c
          where c.student_id = ra.student_id
            and target_date between c.date and coalesce(c.end_date, c.date)
            and c.kind = 'club_attending'
            and c.approval in ('auto_approved', 'approved')
        )
      )
    on conflict (trip_id, student_id) do nothing;

    -- S5: roster generation ADDED but never REMOVED. `on conflict do nothing`
    -- means a student taken off a route stayed on today's trip for ever — and
    -- because they can never be given an outcome, they block the driver from
    -- ending the trip at all. Mirrors the club-cancellation branch, which
    -- already does exactly this.
    --
    -- Only `scheduled` rows. Anything further along is a real record of a real
    -- child on a real van, and no amount of roster editing may delete that.
    delete from student_trip_status sts
    where sts.trip_id = v_trip_id
      and sts.status = 'scheduled'
      and not exists (
        select 1 from route_assignments ra
        where ra.route_id = tpl.id and ra.student_id = sts.student_id
      );
  end loop;

  return created;
end;
$$;

-- S8: this is `security definer`, so it was a way for ANY authenticated account
-- -- including a student -- to materialise trip rows for an arbitrary date.
-- Restricted to staff and cron. Clients get the narrow wrapper below instead.
revoke execute on function ensure_daily_trips(date) from public, anon, authenticated;

/**
 * What the apps are allowed to call: make sure TODAY exists.
 *
 * The app calls this on open so the pilot works with no cron at all, which is
 * worth keeping. What is not worth keeping is letting anyone with a session
 * generate trips for arbitrary dates -- including dates far enough out that the
 * roster is wrong, or far enough back to resurrect a purged day.
 */
create or replace function ensure_todays_trips() returns int
language plpgsql security definer set search_path = public as $$
begin
  if not is_active() then
    raise exception 'Your account is not active.';
  end if;
  return ensure_daily_trips(current_date);
end;
$$;

grant execute on function ensure_todays_trips() to authenticated;

-- ---------------------------------------------------------------------------
-- Change requests: auto-approve before cutoff, queue after it
-- ---------------------------------------------------------------------------

create or replace function decide_change_request() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  org organization%rowtype;
  cutoff timestamptz;
  span text;
begin
  select * into org from organization where id = 1;

  -- The cutoff is judged against the FIRST day the request covers. A holiday
  -- booked in advance is always in time; only the day it starts on can be late.
  -- Morning cutoff governs absence; afternoon governs pickup and club changes.
  cutoff := (new.date + case
    when new.kind = 'absent' then org.morning_cutoff
    else org.afternoon_cutoff
  end)::timestamptz;

  -- S4: the cutoff is a WALL CLOCK, and the thing that actually matters is the
  -- trip boundary. Between 06:30 and the van pulling away, an absence sat
  -- `pending` -- so if nobody happened to be watching the queue, the driver
  -- waited at the hub for a child who was never coming, then filed a no-show
  -- that alarmed the parents and the office about a child sitting at home.
  --
  -- So: auto-approve any time before that student's trip has actually STARTED,
  -- and hard-freeze the moment it does. An unnecessary absence costs a stop. A
  -- missed one costs a false alarm and a phone call.
  if new.kind in ('absent', 'parent_pickup') then
    if exists (
      select 1
      from student_trip_status sts
      join daily_trips t on t.id = sts.trip_id
      where sts.student_id = new.student_id
        and t.date = new.date
        and t.status in ('active', 'completed')
    ) then
      -- The van is out. Only a coordinator can change anything now, because the
      -- driver is already working from the roster as it stands.
      new.approval := 'pending';
    elsif now() <= cutoff or new.date > current_date then
      new.approval := 'auto_approved';
      new.reviewed_at := now();
    else
      -- Past the wall-clock cutoff, but the van has NOT left. This is the window
      -- the old rule got wrong, and it is the common case: a parent noticing at
      -- 07:00 that their child is ill.
      new.approval := 'auto_approved';
      new.reviewed_at := now();
    end if;

    span := case
      when new.end_date is null or new.end_date = new.date then new.date::text
      else new.date::text || ' to ' || new.end_date::text
    end;

    if new.approval = 'pending' then
      insert into notifications (user_id, title, body, kind)
      select p.id, 'Change needs approval — the van has already left',
             (select full_name from profiles where id = new.student_id)
               || ' — ' || new.kind::text || ' for ' || span || '.',
             'approval'
      from profiles p where p.role in ('coordinator', 'admin') and p.status = 'active';
    end if;

    return new;
  end if;

  span := case
    when new.end_date is null or new.end_date = new.date then new.date::text
    else new.date::text || ' to ' || new.end_date::text
  end;

  if now() <= cutoff then
    new.approval := 'auto_approved';
    new.reviewed_at := now();
  else
    -- Blueprint §4.2: "Late changes require coordinator approval and should show
    -- Pending until resolved."
    new.approval := 'pending';

    insert into notifications (user_id, title, body, kind)
    select p.id, 'Late change needs approval',
           (select full_name from profiles where id = new.student_id)
             || ' — ' || new.kind::text || ' for ' || span || '.',
           'approval'
    from profiles p where p.role in ('coordinator', 'admin') and p.status = 'active';
  end if;

  return new;
end;
$$;

create trigger on_change_request_created before insert on change_requests
  for each row execute function decide_change_request();

-- Once a change is approved (immediately or by a coordinator), push it into
-- today's roster so the driver sees it.
create or replace function apply_change_request() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.approval not in ('auto_approved', 'approved') then
    return new;
  end if;

  if new.kind in ('absent', 'parent_pickup') then
    update student_trip_status sts
    set status = case new.kind
                   when 'absent' then 'absent'::rider_status
                   else 'parent_pickup'::rider_status
                 end,
        note = coalesce(new.reason, sts.note),
        updated_by = new.requested_by,
        updated_at = now()
    from daily_trips t
    where sts.trip_id = t.id
      -- Every day the request spans that already has trips generated. Days
      -- further out have no rows yet; ensure_daily_trips seats them as Absent
      -- when it reaches them, reading the same range.
      and t.date between new.date and coalesce(new.end_date, new.date)
      and sts.student_id = new.student_id
      -- Do not overwrite an outcome the driver already recorded.
      and sts.status in ('scheduled', 'waiting');
  end if;

  -- Club attendance changes what the club trip's roster should be.
  if new.kind in ('club_attending', 'club_cancelled', 'not_attending') then
    perform ensure_daily_trips(new.date);
  end if;

  if new.kind in ('club_cancelled', 'not_attending') then
    delete from student_trip_status sts
    using daily_trips t, route_templates rt
    where sts.trip_id = t.id
      and t.route_id = rt.id
      and rt.type = 'club'
      and t.date between new.date and coalesce(new.end_date, new.date)
      and sts.student_id = new.student_id
      and sts.status = 'scheduled';
  end if;

  return new;
end;
$$;

create trigger on_change_request_applied after insert or update on change_requests
  for each row execute function apply_change_request();

-- ---------------------------------------------------------------------------
-- Notifications (blueprint §6.2 matrix) + audit log
-- ---------------------------------------------------------------------------

create or replace function notify_on_rider_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  student_name text;
  when_txt text := to_char(now(), 'HH12:MI AM');
  title text;
  body text;
  kind_txt text := new.status::text;
  audience uuid[];
begin
  if new.status = old.status then
    return new;
  end if;

  select full_name into student_name from profiles where id = new.student_id;
  student_name := coalesce(nullif(student_name, ''), 'The student');

  -- Who hears about it, per the blueprint's notification matrix.
  case new.status
    when 'waiting' then
      -- Student checked in -> driver and coordinator.
      title := student_name || ' is waiting at the hub';
      body  := 'Checked in at ' || when_txt || '.';
      select array_agg(id) into audience from (
        select p.id from profiles p
        where (p.role in ('coordinator', 'admin') and p.status = 'active')
        union
        select t.driver_id from daily_trips t where t.id = new.trip_id and t.driver_id is not null
      ) x;

    when 'boarded' then
      if old.status in ('absent', 'parent_pickup', 'no_show') then
        -- A child the record said was NOT travelling is now on the van. This is
        -- the state the whole app exists to prevent, and the fix is to make it
        -- recordable rather than to leave the driver with no buttons and the
        -- child in the vehicle anyway. So it is not filed as a routine boarding:
        -- the coordinator hears about it, because they are holding the absence
        -- request this just contradicted, and the guardians are told in words
        -- that say what changed.
        title := student_name || ' boarded after being recorded as '
                 || replace(old.status::text, '_', ' ');
        body  := coalesce(nullif(btrim(new.note), ''), 'No reason was given.')
                 || ' Boarded at ' || when_txt || '.';
        kind_txt := 'boarded_after_away';
        select array_agg(id) into audience from (
          select parent_id as id from guardian_links
          where student_id = new.student_id and status = 'accepted'
          union
          select p.id from profiles p
          where p.role in ('coordinator', 'admin') and p.status = 'active'
        ) x;
      else
        title := student_name || ' boarded the vehicle';
        body  := 'Confirmed by the driver at ' || when_txt || '.';
        select array_agg(parent_id) into audience from guardian_links
        where student_id = new.student_id and status = 'accepted';
      end if;

    when 'dropped_off' then
      title := student_name || ' was dropped off safely';
      body  := 'Confirmed by the driver at ' || when_txt || '.';
      select array_agg(parent_id) into audience from guardian_links
      where student_id = new.student_id and status = 'accepted';

    when 'no_show' then
      -- S2: a no-show after a CHECK-IN is not the same event as a no-show from
      -- nothing. The first means the child told us they were at the hub and then
      -- was not picked up — somebody should be looking for them. The second
      -- usually means they stayed home and nobody said. Same status, because
      -- splitting it would double every downstream branch; different escalation,
      -- because they are different emergencies.
      if new.check_in_time is not null then
        title := 'URGENT — ' || student_name || ' checked in but was not picked up';
        body  := student_name || ' said they were at the hub at '
                 || to_char(new.check_in_time, 'HH12:MI AM')
                 || ' and the driver recorded a no-show at ' || when_txt
                 || '. Nobody knows where they are.';
        kind_txt := 'no_show_after_checkin';
      else
        title := student_name || ' did not appear at the hub';
        body  := 'The driver recorded a no-show at ' || when_txt || '.';
      end if;
      select array_agg(id) into audience from (
        select parent_id as id from guardian_links
        where student_id = new.student_id and status = 'accepted'
        union
        select p.id from profiles p
        where p.role in ('coordinator', 'admin') and p.status = 'active'
      ) x;

    when 'unable_to_drop_off' then
      -- Blueprint §6.3: student remains onboard; coordinator must act.
      title := 'URGENT — could not drop off ' || student_name;
      body  := coalesce(new.note, 'The driver could not complete the planned drop-off.')
               || ' The student is still on the vehicle.';
      select array_agg(id) into audience from (
        select parent_id as id from guardian_links
        where student_id = new.student_id and status = 'accepted'
        union
        select p.id from profiles p
        where p.role in ('coordinator', 'admin') and p.status = 'active'
      ) x;

    else
      return new;
  end case;

  if audience is not null then
    insert into notifications (user_id, title, body, kind)
    select distinct u, title, body, kind_txt
    from unnest(audience) as u
    where u is not null;
  end if;

  return new;
end;
$$;

create trigger on_rider_status_change after update on student_trip_status
  for each row execute function notify_on_rider_status();

-- Boarding a student who is on the record as away is an exception, and an
-- exception with no explanation is just a contradiction in the data. The note is
-- required HERE and not only in the driver's app, because "the UI collects it"
-- is exactly the guarantee that a direct API call ignores -- and this is the one
-- write where the record and the child disagree about where the child is.
--
-- The note lands in audit_logs.reason via log_rider_status(), and in the
-- notification body via notify_on_rider_status(). Staff overrides already carry
-- one ("Override by <name>: <reason>"), so this costs them nothing.
create or replace function guard_boarding_after_away() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'boarded'
     and old.status in ('absent', 'parent_pickup', 'no_show')
     and coalesce(btrim(new.note), '') = '' then
    raise exception
      'Boarding a student recorded as % needs a note saying what happened.',
      replace(old.status::text, '_', ' ');
  end if;
  return new;
end;
$$;

create trigger on_boarding_after_away before update on student_trip_status
  for each row execute function guard_boarding_after_away();

-- Every status change is logged. Blueprint §2.1 requires a reason for staff
-- overrides; the app collects it and it lands in `reason` here.
create or replace function log_rider_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    insert into audit_logs (entity_type, entity_id, action, old_value, new_value, reason, changed_by)
    values (
      'student_trip_status', new.id, 'status_change',
      jsonb_build_object('status', old.status),
      jsonb_build_object('status', new.status),
      new.note,
      auth.uid()
    );
  end if;
  return new;
end;
$$;

create trigger on_rider_status_audit after update on student_trip_status
  for each row execute function log_rider_status();

-- ---------------------------------------------------------------------------
-- Admin trip controls: re-run and delete, both requiring a reason.
--
-- These exist for testing and for correcting a trip that went wrong. Both are
-- destructive to a trip's recorded history, so both are:
--   * admin only -- not coordinators;
--   * refused without a reason -- enforced HERE, in the database, not just in
--     the UI, so it cannot be skipped by calling the API directly;
--   * written to audit_logs, which is how anyone later can see a trip was reset
--     or removed, by whom, and why.
-- ---------------------------------------------------------------------------

-- Put a trip back to the start: scheduled, not started, every rider back to
-- 'scheduled' with their check-in/board/drop-off times and notes cleared. The
-- students, driver, vehicle, stops, and planned times stay -- it is the same
-- trip, run again from the top.
create or replace function rerun_trip(target_trip uuid, reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  trimmed text := trim(coalesce(reason, ''));
  before jsonb;
begin
  if not is_admin() then
    raise exception 'Only an administrator can re-run a trip.';
  end if;
  if trimmed = '' then
    raise exception 'A reason is required to re-run a trip.';
  end if;

  select jsonb_build_object('status', status, 'started_at', started_at, 'ended_at', ended_at)
    into before
  from daily_trips where id = target_trip;

  if before is null then
    raise exception 'That trip no longer exists.';
  end if;

  update student_trip_status
     set status = 'scheduled',
         check_in_time = null,
         board_time = null,
         dropoff_time = null,
         note = null,
         updated_by = auth.uid(),
         updated_at = now()
   where trip_id = target_trip;

  update daily_trips
     set status = 'scheduled',
         started_at = null,
         ended_at = null,
         delay_minutes = null,
         delay_reason = null
   where id = target_trip;

  -- Wipe the van's stop-by-stop progress too, or a re-run would show last run's
  -- arrival and departure times against a fresh trip.
  delete from trip_stop_progress where trip_id = target_trip;

  insert into audit_logs (entity_type, entity_id, action, old_value, new_value, reason, changed_by)
  values ('daily_trips', target_trip, 'rerun', before,
          jsonb_build_object('status', 'scheduled'), trimmed, auth.uid());
end;
$$;
grant execute on function rerun_trip(uuid, text) to authenticated;

-- Remove a trip from the board.
--
-- This CANCELS rather than hard-deletes, and the difference is the whole point.
-- ensure_daily_trips() rebuilds today's trips from every active route template
-- on every staff screen focus, inserting `on conflict (route_id, date) do
-- nothing`. A real DELETE frees that (route, date) slot, so the very next screen
-- focus recreated the trip -- it "came back". A cancelled row still occupies the
-- slot, so the conflict clause skips it and it stays gone. The board hides
-- cancelled trips, so to anyone using the app it is deleted; the row survives
-- only to hold the slot (and as the audit trail). Re-run brings it back.
create or replace function delete_trip(target_trip uuid, reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  trimmed text := trim(coalesce(reason, ''));
  before jsonb;
begin
  if not is_admin() then
    raise exception 'Only an administrator can delete a trip.';
  end if;
  if trimmed = '' then
    raise exception 'A reason is required to delete a trip.';
  end if;

  select to_jsonb(t) into before from daily_trips t where id = target_trip;
  if before is null then
    raise exception 'That trip no longer exists.';
  end if;

  update daily_trips set status = 'cancelled' where id = target_trip;

  insert into audit_logs (entity_type, entity_id, action, old_value, new_value, reason, changed_by)
  values ('daily_trips', target_trip, 'delete',
          before, jsonb_build_object('status', 'cancelled'), trimmed, auth.uid());
end;
$$;
grant execute on function delete_trip(uuid, text) to authenticated;

-- Approve or reject a parent's hub/school change, and apply it on approval.
--
-- Staff only. Approving writes the requested hubs and school straight onto the
-- student's record; from then on the daily generation seats them from the new
-- hubs. It does NOT move them onto a route by itself -- which route serves a hub
-- is the office's call, so a coordinator may still need to re-seat the child with
-- the route tools. Either way the parent is told the outcome.
create or replace function review_assignment_request(request_id uuid, approve boolean, note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  req assignment_requests%rowtype;
begin
  if not is_staff() then
    raise exception 'Only transport staff can review assignment changes.';
  end if;

  select * into req from assignment_requests where id = request_id;
  if not found then
    raise exception 'That request no longer exists.';
  end if;
  if req.status <> 'pending' then
    raise exception 'That request has already been reviewed.';
  end if;

  update assignment_requests
     set status = case when approve then 'approved'::approval_status else 'rejected' end,
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         review_note = note
   where id = request_id;

  if approve then
    update students
       set school_id = req.school_id,
           morning_hub_id = req.morning_hub_id,
           afternoon_hub_id = req.afternoon_hub_id
     where student_id = req.student_id;
  end if;

  if req.requested_by is not null then
    insert into notifications (user_id, title, body, kind)
    values (
      req.requested_by,
      case when approve then 'Assignment change approved'
           else 'Assignment change not approved' end,
      case when approve
           then 'The transport office approved the hub/school change for your child.'
           else coalesce(nullif(trim(note), ''),
                         'The transport office did not approve the requested change.') end,
      'approval'
    );
  end if;
end;
$$;
grant execute on function review_assignment_request(uuid, boolean, text) to authenticated;

-- A new hub/school request needs a person, so tell the office it is waiting.
create or replace function notify_on_assignment_request() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  child_name text;
begin
  select full_name into child_name from profiles where id = new.student_id;
  insert into notifications (user_id, title, body, kind)
  select p.id,
         'Assignment change requested',
         coalesce(nullif(child_name, ''), 'A student')
           || ' has a hub/school change waiting for your approval.',
         'approval'
  from profiles p where p.role in ('coordinator', 'admin') and p.status = 'active';
  return new;
end;
$$;

create trigger on_assignment_request_created after insert on assignment_requests
  for each row execute function notify_on_assignment_request();

-- Delay reported -> affected parents (blueprint §6.2).
create or replace function notify_on_incident() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  route_name text;
  student_name text;
begin
  select rt.name into route_name
  from daily_trips t join route_templates rt on rt.id = t.route_id
  where t.id = new.trip_id;

  if new.student_id is not null then
    -- An incident about ONE child is not route-wide news, and its description
    -- names that child -- so broadcasting it would tell every other family on
    -- the van who was left behind, or who was in trouble. Only their own
    -- guardians hear it. Coordinators still get everything, below.
    select full_name into student_name from profiles where id = new.student_id;
    student_name := coalesce(nullif(btrim(student_name), ''), 'a student');

    insert into notifications (user_id, title, body, kind)
    select gl.parent_id,
           'Urgent — ' || student_name || ' on route ' || coalesce(route_name, ''),
           coalesce(new.description, 'The driver has reported an issue.'),
           new.kind::text
    from guardian_links gl
    where gl.student_id = new.student_id and gl.status = 'accepted';
  else
    insert into notifications (user_id, title, body, kind)
    select distinct gl.parent_id,
           case when new.kind = 'delay'
                then 'Route ' || coalesce(route_name, '') || ' is delayed'
                else 'Incident on route ' || coalesce(route_name, '') end,
           coalesce(new.description, 'The driver has reported an issue.'),
           new.kind::text
    from student_trip_status sts
    join guardian_links gl on gl.student_id = sts.student_id and gl.status = 'accepted'
    where sts.trip_id = new.trip_id
      and sts.status not in ('absent', 'parent_pickup', 'no_show');
  end if;

  insert into notifications (user_id, title, body, kind)
  select p.id,
         'Incident reported on ' || coalesce(route_name, 'a route'),
         coalesce(new.description, new.kind::text),
         new.kind::text
  from profiles p where p.role in ('coordinator', 'admin') and p.status = 'active';

  return new;
end;
$$;

create trigger on_incident_reported after insert on incidents
  for each row execute function notify_on_incident();

-- ---------------------------------------------------------------------------
-- N5 — an announcement that goes to the people it is about
--
-- `announcements.route_id` has existed since the first schema and was ignored:
-- the composer fanned every announcement out to EVERY active student, parent and
-- driver in the organisation, from the client. Fine at three vans. At thirty it
-- is how people turn notifications off, and once they have, the urgent ones stop
-- arriving too.
--
-- Moved into a trigger so the fan-out cannot be skipped or got wrong by whatever
-- posts the announcement, and so the targeting lives with the data.
-- ---------------------------------------------------------------------------

create or replace function notify_on_announcement() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into notifications (user_id, title, body, kind)
  select distinct u.id, new.title, new.body, 'announcement'
  from (
    -- One child in particular: them and their guardians, nobody else.
    select p.id from profiles p
    where new.student_id is not null
      and p.status = 'active'
      and (p.id = new.student_id or is_guardian_of_by(p.id, new.student_id))

    union

    -- One route: today's riders on it, their guardians, and its driver.
    select x.id from (
      select sts.student_id as id from student_trip_status sts
      join daily_trips t on t.id = sts.trip_id
      where new.student_id is null and new.route_id is not null
        and t.route_id = new.route_id and t.date >= current_date
      union
      select gl.parent_id from student_trip_status sts
      join daily_trips t on t.id = sts.trip_id
      join guardian_links gl on gl.student_id = sts.student_id and gl.status = 'accepted'
      where new.student_id is null and new.route_id is not null
        and t.route_id = new.route_id and t.date >= current_date
      union
      select t.driver_id from daily_trips t
      where new.student_id is null and new.route_id is not null
        and t.route_id = new.route_id and t.date >= current_date
    ) x
    join profiles p on p.id = x.id and p.status = 'active'

    union

    -- Untargeted: everybody, which is now a deliberate choice rather than the
    -- only behaviour available.
    select p.id from profiles p
    where new.student_id is null and new.route_id is null
      and p.status = 'active'
      and p.role in ('student', 'parent', 'driver')
  ) u
  where u.id is not null;

  return new;
end;
$$;

create trigger on_announcement_posted after insert on announcements
  for each row execute function notify_on_announcement();

-- ---------------------------------------------------------------------------
-- Leaving a stop (the same rule as End trip, applied eight stops earlier)
--
-- guard_trip_completion below is the backstop: no trip closes with a student
-- unaccounted for. But the backstop fires at the END of the route, which can be
-- forty minutes and eight stops after the van pulled away from the child. By
-- then the van is nowhere near them and nobody has been told.
--
-- So the same question is asked at every departure, where the answer is still
-- cheap: does anyone at THIS stop still have no outcome?
--
-- The driver is never blocked. They can always leave -- a van that cannot move
-- is its own safety problem. Leaving anyway just stops being free: it files an
-- incident per child and tells their guardians and the office straight away,
-- instead of being silent.
-- ---------------------------------------------------------------------------

-- Who is unaccounted for at one stop. One definition, used by the guard, by the
-- incident recorder, and mirrored in the driver's app (see unresolvedAtStop in
-- src/lib/types.ts) so the pre-flight warning names exactly who the database
-- would refuse on.
--
-- A rider sits at two stops -- where they get on and where they get off -- so
-- which statuses count as unresolved depends on which of the two this is:
--   * boarding here: still `scheduled` (never seen) or `waiting` (they told us
--     they were at the hub and we drove off without them -- the worse case,
--     because the app KNEW they were there);
--   * getting off here: still `boarded` or `in_transit`, i.e. on the van as it
--     leaves the place they were supposed to get out.
-- `unable_to_drop_off` is deliberately not unresolved: that one is already
-- raised, already blocks trip completion, and the driver is meant to drive on.
create or replace function riders_unresolved_at_stop(target_trip uuid, target_stop uuid)
returns setof student_trip_status
language sql stable security definer set search_path = public as $$
  select sts.* from student_trip_status sts
  where sts.trip_id = target_trip
    and (
      (sts.pickup_stop_id  = target_stop and sts.status in ('scheduled', 'waiting'))
      or
      (sts.dropoff_stop_id = target_stop and sts.status in ('boarded', 'in_transit'))
    );
$$;

-- Security definer, so it reads past RLS -- which is right for a trigger and
-- wrong for a client. Postgres grants EXECUTE to public by default, and every
-- function in this schema is reachable over PostgREST as /rpc/<name>, so without
-- this any signed-in account could ask it about any trip and any stop and read
-- back rider rows it cannot select. The triggers below are unaffected: they run
-- inside security-definer functions owned by the same role.
revoke execute on function riders_unresolved_at_stop(uuid, uuid) from public, anon, authenticated;

create or replace function guard_stop_departure() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  unresolved int;
begin
  -- An arrival is recorded ONCE. A second tap is a mistap, not a correction, and
  -- it must not quietly move the timestamp the parents were already shown. Staff
  -- can still fix it -- that is what the exception queue is for -- but the
  -- driver's app cannot overwrite its own history.
  if tg_op = 'UPDATE' and not is_staff() and not undoing() then
    if old.arrived_at is not null then
      new.arrived_at := old.arrived_at;
    end if;
    if old.departed_at is not null then
      new.departed_at := old.departed_at;
    end if;
  end if;

  -- Caught here as well as by the check constraint, so the driver gets a
  -- sentence instead of a constraint name. The realistic cause is a device clock
  -- that has jumped, since both timestamps come from the phone.
  if new.arrived_at is not null and new.departed_at is not null
     and new.departed_at < new.arrived_at then
    raise exception
      'Departure (%) is before arrival (%) at this stop. Check the device clock.',
      to_char(new.departed_at, 'HH24:MI:SS'), to_char(new.arrived_at, 'HH24:MI:SS');
  end if;

  -- Only the moment a departure is FIRST recorded is guarded. Later edits to the
  -- row (a staff correction, a skip flag) do not re-ask the question.
  if new.departed_at is null then return new; end if;
  if tg_op = 'UPDATE' and old.departed_at is not null then return new; end if;

  select count(*) into unresolved
  from riders_unresolved_at_stop(new.trip_id, new.stop_id);

  if unresolved > 0 and not new.departed_with_unresolved then
    raise exception
      'Cannot leave this stop: % student(s) here still have no outcome.', unresolved;
  end if;

  return new;
end;
$$;

create trigger on_stop_departure before insert or update on trip_stop_progress
  for each row execute function guard_stop_departure();

-- The cost of leaving anyway. One incident PER CHILD, because each one is
-- separately unaccounted for and each one gets resolved separately in the
-- exception queue. Setting student_id is what keeps the description off the
-- route-wide broadcast (see notify_on_incident) -- the other families do not get
-- told this child's name, but the office and that child's own guardians do,
-- immediately.
create or replace function record_forced_departure() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  stop_name text;
  actor_name text;
  driver uuid;
  rider record;
begin
  if new.departed_at is null or not new.departed_with_unresolved then
    return new;
  end if;
  -- Already filed on an earlier write of this row.
  if tg_op = 'UPDATE' and old.departed_at is not null and old.departed_with_unresolved then
    return new;
  end if;

  select coalesce(h.name, s.name, 'a stop') into stop_name
  from route_stops rs
  left join hubs h    on h.id = rs.hub_id
  left join schools s on s.id = rs.school_id
  where rs.id = new.stop_id;

  select t.driver_id into driver from daily_trips t where t.id = new.trip_id;

  -- Two steps on purpose. `select coalesce(...) into` does nothing when the
  -- select matches NO row, so the variable stays null and every || below it
  -- yields null -- an incident with no description at all. The caller is not
  -- always a profile: a service-role write, or a cron job, has no auth.uid().
  select p.full_name into actor_name from profiles p where p.id = auth.uid();
  actor_name := coalesce(nullif(btrim(actor_name), ''), 'The driver');

  for rider in
    select u.student_id,
           u.status,
           u.pickup_stop_id,
           coalesce(nullif(p.full_name, ''), 'A student') as name
    from riders_unresolved_at_stop(new.trip_id, new.stop_id) u
    join profiles p on p.id = u.student_id
  loop
    insert into incidents (trip_id, student_id, driver_id, kind, severity, description)
    values (
      new.trip_id, rider.student_id, driver, 'other', 'high',
      actor_name || ' left ' || stop_name || ' at '
        || to_char(new.departed_at, 'HH12:MI AM') || ' and '
        || rider.name
        || case when rider.pickup_stop_id = new.stop_id
                then ' did not board (still recorded as '
                else ' did not get off (still recorded as ' end
        || replace(rider.status::text, '_', ' ')
        || '). Nobody has confirmed where they are.'
    );
  end loop;

  return new;
end;
$$;

create trigger on_forced_departure after insert or update on trip_stop_progress
  for each row execute function record_forced_departure();

-- ---------------------------------------------------------------------------
-- C8 — what may follow what
--
-- RLS checks WHO may write WHICH status. It has never checked what may follow
-- what. So a raw call with a driver's token could move a rider straight from
-- `scheduled` to `dropped_off` — never boarded, never on the van — and every
-- downstream consumer would accept it: the parent's timeline, the weekly report,
-- the trip-completion guard. The UI was the only thing preventing it, which
-- flatly contradicts the README's claim that these are database rules.
--
-- The table below is the state machine, written down. Anything not in it is
-- refused.
-- ---------------------------------------------------------------------------

-- Is this write a deliberate reversal (see undo_rider_status / undo_stop_progress)?
--
-- Undo is a compensating action, not a forward move. Enumerating every reverse
-- edge in the transition table would double its size and turn a statement of
-- "what normally happens" into noise. A transaction-local flag, set only inside
-- the undo functions, keeps the table meaning what it says.
create or replace function undoing() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.undoing', true), '') = 'on';
$$;

create or replace function guard_rider_transition() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ok boolean;
begin
  if new.status = old.status then
    return new;
  end if;

  -- Blueprint §2.1: staff may override an official status, and already must give
  -- a reason for it. The exception queue is where a genuinely stuck record gets
  -- unstuck, and it cannot do that job through this table.
  if is_staff() or undoing() then
    return new;
  end if;

  select true into ok from (values
    -- Getting ready
    ('scheduled',         'waiting'),            -- the student checks in
    ('scheduled',         'boarded'),            -- boarded without checking in
    ('scheduled',         'absent'),
    ('scheduled',         'parent_pickup'),
    ('scheduled',         'no_show'),
    ('waiting',           'boarded'),
    ('waiting',           'absent'),
    ('waiting',           'parent_pickup'),
    ('waiting',           'no_show'),
    -- On the van
    ('boarded',           'in_transit'),         -- the van leaves their stop
    ('boarded',           'dropped_off'),        -- let off before it ever moved
    ('boarded',           'parent_pickup'),      -- parent arrives and takes them off again
    ('boarded',           'unable_to_drop_off'),
    ('in_transit',        'dropped_off'),
    ('in_transit',        'unable_to_drop_off'),
    -- Finishing
    ('dropped_off',       'completed'),          -- set by guard_trip_completion
    -- Turned up after all (C4). The note is separately mandatory.
    ('absent',            'boarded'),
    ('parent_pickup',     'boarded'),
    ('no_show',           'boarded'),
    -- Only a coordinator clears this one, and is_staff() already returned above.
    ('unable_to_drop_off','dropped_off')
  ) as t(from_status, to_status)
  where t.from_status = old.status::text
    and t.to_status   = new.status::text;

  if not coalesce(ok, false) then
    raise exception
      'A student cannot go from % to %. That is not a step this system allows.',
      replace(old.status::text, '_', ' '), replace(new.status::text, '_', ' ');
  end if;

  return new;
end;
$$;

create trigger on_rider_transition before update on student_trip_status
  for each row execute function guard_rider_transition();

-- ---------------------------------------------------------------------------
-- C5 — taking back a mistap
--
-- Before this, a mistapped `no_show` was TERMINAL: the card rendered with no
-- actions and the only way out was a coordinator, mid-route, from a desk. Same
-- for a departure — once `departed_at` was written the arrive button was gone
-- and the next stop unlocked.
--
-- Both undo functions write a COMPENSATING audit entry rather than silently
-- reverting, so the log reads "this happened, then it was taken back" instead of
-- quietly ceasing to mention it. That is the difference between an undo and a
-- cover-up, and this data settles disputes about children.
-- ---------------------------------------------------------------------------

create or replace function undo_rider_status(row_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  row student_trip_status%rowtype;
  entry audit_logs%rowtype;
  window_sec int;
  previous rider_status;
begin
  select * into row from student_trip_status where id = row_id;
  if row is null then
    raise exception 'That student record no longer exists.';
  end if;

  if not (drives_trip(row.trip_id) or is_staff()) then
    raise exception 'Only the driver of this trip, or the transport office, can undo it.';
  end if;

  select coalesce(undo_window_sec, 90) into window_sec from organization where id = 1;

  -- The most recent status change on this row. `old_value` already holds what it
  -- was, which is why this needs no new bookkeeping table.
  select * into entry from audit_logs
  where entity_type = 'student_trip_status' and entity_id = row_id and action = 'status_change'
  order by changed_at desc limit 1;

  if entry is null then
    raise exception 'There is nothing to undo for this student.';
  end if;
  if now() - entry.changed_at > make_interval(secs => window_sec) then
    raise exception
      'Too late to undo — that was more than % seconds ago. Ask the transport office to change it.',
      window_sec;
  end if;

  previous := (entry.old_value ->> 'status')::rider_status;

  perform set_config('app.undoing', 'on', true);

  update student_trip_status
  set status = previous,
      -- The timestamps the reverted status implies it does not have.
      board_time   = case when previous in ('boarded', 'in_transit') then board_time else null end,
      dropoff_time = case when previous in ('dropped_off', 'completed') then dropoff_time else null end,
      updated_by   = auth.uid(),
      updated_at   = now()
  where id = row_id;

  insert into audit_logs (entity_type, entity_id, action, old_value, new_value, reason, changed_by)
  values (
    'student_trip_status', row_id, 'status_undo',
    jsonb_build_object('status', row.status),
    jsonb_build_object('status', previous),
    'Undone by the driver within the ' || window_sec || ' second window.',
    auth.uid()
  );

  return jsonb_build_object('undone', true, 'from', row.status, 'to', previous);
end;
$$;

grant execute on function undo_rider_status(uuid) to authenticated;

create or replace function undo_stop_progress(target_trip uuid, target_stop uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  prog trip_stop_progress%rowtype;
  window_sec int;
  undone text;
begin
  if not (drives_trip(target_trip) or is_staff()) then
    raise exception 'Only the driver of this trip, or the transport office, can undo it.';
  end if;

  select * into prog from trip_stop_progress
  where trip_id = target_trip and stop_id = target_stop;
  if prog is null then
    raise exception 'Nothing has been recorded at this stop yet.';
  end if;

  select coalesce(undo_window_sec, 90) into window_sec from organization where id = 1;

  perform set_config('app.undoing', 'on', true);

  -- Most recent action first: a departure is undone before an arrival, because
  -- the departure is what the driver just did.
  if prog.departed_at is not null then
    if now() - prog.departed_at > make_interval(secs => window_sec) and not is_staff() then
      raise exception 'Too late to undo leaving this stop. Ask the transport office.';
    end if;

    update trip_stop_progress
    set departed_at = null, departed_with_unresolved = false, skipped = false
    where id = prog.id;

    -- Leaving promoted everyone who boarded here to in_transit. Un-leaving has
    -- to put them back, or the roster says the van moved and the record says it
    -- did not.
    update student_trip_status
    set status = 'boarded', updated_by = auth.uid(), updated_at = now()
    where trip_id = target_trip and pickup_stop_id = target_stop and status = 'in_transit';

    undone := 'departure';
  elsif prog.arrived_at is not null then
    if now() - prog.arrived_at > make_interval(secs => window_sec) and not is_staff() then
      raise exception 'Too late to undo arriving at this stop. Ask the transport office.';
    end if;

    update trip_stop_progress set arrived_at = null where id = prog.id;
    undone := 'arrival';
  else
    raise exception 'Nothing has been recorded at this stop yet.';
  end if;

  insert into audit_logs (entity_type, entity_id, action, old_value, new_value, reason, changed_by)
  values (
    'trip_stop_progress', prog.id, 'stop_progress_undo',
    jsonb_build_object('arrived_at', prog.arrived_at, 'departed_at', prog.departed_at),
    jsonb_build_object('undone', undone),
    'Stop ' || undone || ' undone within the ' || window_sec || ' second window.',
    auth.uid()
  );

  return jsonb_build_object('undone', undone);
end;
$$;

grant execute on function undo_stop_progress(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- End-of-trip rule (blueprint §5.1)
--
-- "A driver cannot complete the trip while a student remains Scheduled,
-- Waiting, Boarded, or In Transit." And an unable-to-drop-off student blocks
-- closure until a coordinator resolves it.
-- ---------------------------------------------------------------------------

create or replace function guard_trip_completion() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  unresolved int;
  stuck int;
begin
  if new.status <> 'completed' or old.status = 'completed' then
    return new;
  end if;

  select count(*) into unresolved from student_trip_status
  where trip_id = new.id
    and status in ('scheduled', 'waiting', 'boarded', 'in_transit');

  select count(*) into stuck from student_trip_status
  where trip_id = new.id and status = 'unable_to_drop_off';

  if unresolved > 0 then
    raise exception 'Cannot end the trip: % student(s) still have no final status.', unresolved;
  end if;

  if stuck > 0 and not is_staff() then
    raise exception 'Cannot end the trip: % student(s) could not be dropped off. A coordinator must resolve this.', stuck;
  end if;

  -- Everyone who travelled is now Completed.
  update student_trip_status
  set status = 'completed', updated_at = now()
  where trip_id = new.id and status = 'dropped_off';

  new.ended_at := coalesce(new.ended_at, now());
  return new;
end;
$$;

create trigger on_trip_completion before update on daily_trips
  for each row execute function guard_trip_completion();

-- ---------------------------------------------------------------------------
-- The watchdog — the only thing here that watches the clock
--
-- Everything else in this system escalates because a DRIVER TAPPED SOMETHING.
-- End trip is refused, a departure files an incident, a status change notifies a
-- parent. All of it needs the driver's phone to be alive, in their hand, and
-- being used. If the phone dies, or is pocketed, or the driver simply stops
-- tapping, the trip stays `active` for ever and NOBODY IS TOLD ANYTHING.
--
-- The coordinator's exception queue does not cover this either: it is pull-based
-- (someone has to be looking at it) and its "missing" list excludes `scheduled`
-- riders, so a child the van drove past without touching is invisible there too.
--
-- This function is the answer. Five queries, run every five minutes by pg_cron
-- during operating hours. It is the highest-return thing in the remediation plan
-- for one reason: it converts every silent failure in the system into an alert,
-- including the ones nobody enumerated.
--
-- Timezone note: planned times are `time` columns and are read as
-- `(date + time)::timestamptz`, matching decide_change_request(). That resolves
-- in the DATABASE's timezone, so a project running in UTC while the vans run in
-- London will be an hour out twice a year. One place to fix, when it matters.
-- ---------------------------------------------------------------------------

create or replace function transport_watchdog() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cfg organization%rowtype;
  raised int;
  result jsonb := '{}'::jsonb;
  cleared int;
begin
  -- Callable by hand from the office ("check now"), and by cron, which has no
  -- auth.uid() at all. Anyone else signed in gets nothing.
  if auth.uid() is not null and not is_staff() then
    raise exception 'Only the transport office can run the watchdog.';
  end if;

  select * into cfg from organization where id = 1;
  if cfg is null or not cfg.watchdog_enabled then
    return jsonb_build_object('ran', false, 'reason', 'The watchdog is switched off.');
  end if;

  -- -------------------------------------------------------------------------
  -- 1. The trip that should have left and has not been started.
  -- -------------------------------------------------------------------------
  insert into watchdog_alerts (trip_id, stop_id, kind, detail)
  select t.id, fs.id, 'trip_not_started',
         rt.name || ' was due to leave ' || coalesce(h.name, s.name, 'its first stop')
           || ' at ' || to_char(fs.planned_departure, 'HH12:MI AM')
           || ' and the driver has not started the trip.'
  from daily_trips t
  join route_templates rt on rt.id = t.route_id
  join lateral (
    select rs.* from route_stops rs where rs.route_id = t.route_id order by rs.seq limit 1
  ) fs on true
  left join hubs    h on h.id = fs.hub_id
  left join schools s on s.id = fs.school_id
  where t.date = current_date
    and t.status = 'scheduled'
    and fs.planned_departure is not null
    and now() > (t.date + fs.planned_departure)::timestamptz
                + make_interval(mins => cfg.watchdog_trip_start_min)
    -- A trip with nobody on it is not an emergency.
    and exists (select 1 from student_trip_status x where x.trip_id = t.id)
  on conflict do nothing;
  get diagnostics raised = row_count;
  result := result || jsonb_build_object('trip_not_started', raised);

  -- -------------------------------------------------------------------------
  -- 2. The stop with riders on it that the van has not reached.
  -- -------------------------------------------------------------------------
  insert into watchdog_alerts (trip_id, stop_id, kind, detail)
  select t.id, rs.id, 'stop_not_reached',
         rt.name || ' was due at ' || coalesce(h.name, s.name, 'a stop')
           || ' at ' || to_char(rs.planned_arrival, 'HH12:MI AM')
           || ' and has not arrived. '
           -- The same "who has no outcome here" rule the departure guard uses,
           -- so it counts riders due to get OFF as well as riders due to get on.
           || (select count(*) from riders_unresolved_at_stop(t.id, rs.id))::text
           || ' student(s) are still due at this stop.'
  from daily_trips t
  join route_templates rt on rt.id = t.route_id
  join route_stops rs on rs.route_id = t.route_id
  left join hubs    h on h.id = rs.hub_id
  left join schools s on s.id = rs.school_id
  left join trip_stop_progress p on p.trip_id = t.id and p.stop_id = rs.id
  where t.date = current_date
    and t.status = 'active'
    and rs.planned_arrival is not null
    and p.arrived_at is null
    and coalesce(p.skipped, false) = false
    -- The school on an AFTERNOON route is the ORIGIN: the van starts there, so
    -- the driver never marks an arrival and never will. Without this the
    -- watchdog would raise a false alarm on every single afternoon run, which is
    -- the fastest way to teach a coordinator to ignore it. Mirrors `isOrigin` on
    -- the driver's trip screen.
    and not (rs.school_id is not null and rt.type = 'afternoon')
    and now() > (t.date + rs.planned_arrival)::timestamptz
                + make_interval(mins => cfg.watchdog_stop_arrival_min)
    and exists (
      select 1 from student_trip_status x
      where x.trip_id = t.id
        and (x.pickup_stop_id = rs.id or x.dropoff_stop_id = rs.id)
        and x.status not in ('absent', 'parent_pickup')
    )
  on conflict do nothing;
  get diagnostics raised = row_count;
  result := result || jsonb_build_object('stop_not_reached', raised);

  -- -------------------------------------------------------------------------
  -- 3. The student who said they were at the hub, and still is.
  --
  -- The one the whole plan keeps coming back to: the app KNOWS this child is
  -- standing outside, because they told it.
  -- -------------------------------------------------------------------------
  insert into watchdog_alerts (trip_id, stop_id, student_id, kind, detail)
  select sts.trip_id, sts.pickup_stop_id, sts.student_id, 'rider_waiting',
         coalesce(nullif(pr.full_name, ''), 'A student')
           || ' checked in at ' || coalesce(h.name, s.name, 'their hub')
           || ' at ' || to_char(sts.check_in_time, 'HH12:MI AM')
           || ' and has not been boarded since.'
  from student_trip_status sts
  join daily_trips t on t.id = sts.trip_id
  join profiles pr on pr.id = sts.student_id
  left join route_stops rs on rs.id = sts.pickup_stop_id
  left join hubs    h on h.id = rs.hub_id
  left join schools s on s.id = rs.school_id
  where t.date = current_date
    and sts.status = 'waiting'
    and sts.check_in_time is not null
    and now() - sts.check_in_time > make_interval(mins => cfg.watchdog_waiting_min)
  on conflict do nothing;
  get diagnostics raised = row_count;
  result := result || jsonb_build_object('rider_waiting', raised);

  -- -------------------------------------------------------------------------
  -- 4. The trip that never ended. This is the pocketed phone.
  -- -------------------------------------------------------------------------
  insert into watchdog_alerts (trip_id, kind, detail)
  select t.id, 'trip_overrunning',
         rt.name || ' has been running for '
           || round(extract(epoch from (now() - t.started_at)) / 60)::text
           || ' minutes and has not been ended. '
           || (select count(*) from student_trip_status x
               where x.trip_id = t.id and x.status in ('boarded', 'in_transit'))::text
           || ' student(s) are still recorded as on board.'
  from daily_trips t
  join route_templates rt on rt.id = t.route_id
  where t.date = current_date
    and t.status = 'active'
    and t.started_at is not null
    and now() - t.started_at > make_interval(mins => cfg.watchdog_trip_max_min)
  on conflict do nothing;
  get diagnostics raised = row_count;
  result := result || jsonb_build_object('trip_overrunning', raised);

  -- -------------------------------------------------------------------------
  -- 5. The van finished its route and somebody is still on it.
  -- -------------------------------------------------------------------------
  insert into watchdog_alerts (trip_id, stop_id, student_id, kind, detail)
  select sts.trip_id, fin.stop_id, sts.student_id, 'rider_still_onboard',
         coalesce(nullif(pr.full_name, ''), 'A student')
           || ' is still recorded as on board ' || rt.name
           || ', which reached its last stop at '
           || to_char(fin.at_time, 'HH12:MI AM') || '.'
  from student_trip_status sts
  join daily_trips t on t.id = sts.trip_id
  join route_templates rt on rt.id = t.route_id
  join profiles pr on pr.id = sts.student_id
  join lateral (
    select rs.id as stop_id, coalesce(p.departed_at, p.arrived_at) as at_time
    from route_stops rs
    join trip_stop_progress p on p.trip_id = t.id and p.stop_id = rs.id
    where rs.route_id = t.route_id
    order by rs.seq desc
    limit 1
  ) fin on true
  where t.date = current_date
    and sts.status in ('boarded', 'in_transit')
    and fin.at_time is not null
    and now() - fin.at_time > make_interval(mins => cfg.watchdog_onboard_min)
  on conflict do nothing;
  get diagnostics raised = row_count;
  result := result || jsonb_build_object('rider_still_onboard', raised);

  -- -------------------------------------------------------------------------
  -- 6. S6 — an URGENT notification nobody has acknowledged.
  --
  -- Push is best-effort: a flat battery, a revoked token, a phone face-down on a
  -- table. For "could not drop off" and "checked in then not picked up", sending
  -- is not the same as telling, so silence past a few minutes is itself an
  -- event.
  -- -------------------------------------------------------------------------
  insert into watchdog_alerts (notification_id, kind, detail)
  select n.id, 'urgent_unacknowledged',
         coalesce(nullif(p.full_name, ''), 'Someone')
           || ' has not acknowledged: "' || n.title || '" (sent '
           || to_char(n.created_at, 'HH12:MI AM') || ', '
           || case n.delivery_state
                when 'no_token' then 'no push token on file for them'
                when 'failed'   then 'push delivery failed'
                when 'sent'     then 'push delivered, not opened'
                else 'push not yet attempted'
              end
           || '). Phone them.'
  from notifications n
  join profiles p on p.id = n.user_id
  where n.requires_ack
    and n.acknowledged_at is null
    and now() - n.created_at > interval '5 minutes'
  on conflict do nothing;
  get diagnostics raised = row_count;
  result := result || jsonb_build_object('unacknowledged_urgent', raised);

  -- -------------------------------------------------------------------------
  -- Self-clearing. An alert about something that has since sorted itself out is
  -- noise, and a queue of noise is a queue nobody reads.
  -- -------------------------------------------------------------------------
  update watchdog_alerts a
  set resolved_at = now(),
      resolution  = 'Cleared automatically — the condition went away.'
  where a.resolved_at is null
    and case a.kind
      when 'trip_not_started' then
        exists (select 1 from daily_trips t where t.id = a.trip_id and t.status <> 'scheduled')
      when 'stop_not_reached' then
        exists (select 1 from trip_stop_progress p
                where p.trip_id = a.trip_id and p.stop_id = a.stop_id
                  and (p.arrived_at is not null or p.skipped))
      when 'rider_waiting' then
        exists (select 1 from student_trip_status x
                where x.trip_id = a.trip_id and x.student_id = a.student_id
                  and x.status <> 'waiting')
      when 'trip_overrunning' then
        exists (select 1 from daily_trips t where t.id = a.trip_id and t.status <> 'active')
      when 'rider_still_onboard' then
        exists (select 1 from student_trip_status x
                where x.trip_id = a.trip_id and x.student_id = a.student_id
                  and x.status not in ('boarded', 'in_transit'))
      when 'urgent_unacknowledged' then
        exists (select 1 from notifications n
                where n.id = a.notification_id and n.acknowledged_at is not null)
      else false
    end;
  get diagnostics cleared = row_count;

  -- -------------------------------------------------------------------------
  -- Tell the office. Once per alert, ever — `notified_at` is the latch.
  -- -------------------------------------------------------------------------
  insert into notifications (user_id, title, body, kind)
  select p.id,
         case a.kind
           when 'trip_not_started'    then 'Route has not started'
           when 'stop_not_reached'    then 'Van is overdue at a stop'
           when 'rider_waiting'       then 'Student still waiting at a hub'
           when 'trip_overrunning'    then 'Trip has not been ended'
           when 'rider_still_onboard' then 'Student still on board after the route ended'
           when 'urgent_unacknowledged' then 'An urgent message has gone unanswered'
         end,
         a.detail,
         'watchdog'
  from watchdog_alerts a
  cross join profiles p
  where a.notified_at is null
    and a.resolved_at is null
    and p.role in ('coordinator', 'admin')
    and p.status = 'active';

  update watchdog_alerts set notified_at = now() where notified_at is null;

  return result || jsonb_build_object('ran', true, 'cleared', cleared, 'at', now());
end;
$$;

grant execute on function transport_watchdog() to authenticated;

-- The schedule, as a switch in the admin portal — same shape as the weekly
-- maintenance job in retention.sql, and for the same reason: nobody should have
-- to paste cron SQL into a dashboard to make the system look after itself.
--
-- Every five minutes, 06:00–19:59, Monday to Friday. "Operating hours only"
-- matters here: a watchdog that alerts at 3am about a trip nobody was running is
-- how the alerts get muted.
--
-- EXECUTE rather than a direct `cron.*` reference, so this file still installs
-- on a database where pg_cron has never been enabled.
create or replace function watchdog_schedule_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  installed boolean;
  sched text;
begin
  select exists (select 1 from pg_extension where extname = 'pg_cron') into installed;

  if not installed then
    return jsonb_build_object(
      'installed', false,
      'enabled', false,
      'hint', 'pg_cron is not enabled. Supabase dashboard → Database → Extensions → enable pg_cron, then come back.'
    );
  end if;

  execute $q$ select schedule from cron.job where jobname = 'transport-watchdog' $q$ into sched;

  return jsonb_build_object('installed', true, 'enabled', sched is not null, 'schedule', sched);
end;
$$;

create or replace function set_watchdog_schedule(enable boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  installed boolean;
begin
  if not is_staff() then
    raise exception 'Only the transport office can change the watchdog schedule.';
  end if;

  select exists (select 1 from pg_extension where extname = 'pg_cron') into installed;
  if not installed then
    raise exception 'pg_cron is not enabled on this project. Dashboard → Database → Extensions → enable pg_cron, then try again.';
  end if;

  if enable then
    execute $q$
      select cron.schedule(
        'transport-watchdog',
        '*/5 6-19 * * 1-5',
        'select transport_watchdog()'
      )
    $q$;
  else
    begin
      execute $q$ select cron.unschedule('transport-watchdog') $q$;
    exception when others then
      null;  -- already gone
    end;
  end if;

  insert into audit_logs (entity_type, action, new_value, reason, changed_by)
  values (
    'system',
    case when enable then 'watchdog_schedule_enabled' else 'watchdog_schedule_disabled' end,
    jsonb_build_object('enabled', enable),
    'Watchdog schedule changed from the transport office.',
    auth.uid()
  );

  return watchdog_schedule_status();
end;
$$;

grant execute on function watchdog_schedule_status() to authenticated;
grant execute on function set_watchdog_schedule(boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- C6 / S1 / N1 — "your van is nearly here", on the path everything else uses
--
-- These alerts used to be LOCAL notifications scheduled on the device, which
-- failed four ways at once and none of them observably:
--   * they only existed if the app had been opened that day;
--   * web got nothing at all, and web is a supported parent target;
--   * the scheduling effect re-ran on every render, cancelling ALL notifications
--     globally and rebuilding — so there was a window on every render with zero
--     alerts armed;
--   * students marked absent were alerted anyway.
--
-- Moving them onto the `notifications` table buys push, the in-app inbox, web,
-- and a queryable record of what was actually sent. It also makes the later GPS
-- upgrade a change to one query rather than a rewrite.
--
-- Still honest about what it is: "due in 15 minutes", not "15 minutes away".
-- VanEta covers the accurate case and is worded differently on purpose.
-- ---------------------------------------------------------------------------

create or replace function send_arrival_alerts() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sent int := 0;
  batch int;
  milestone int;
begin
  if auth.uid() is not null and not is_staff() then
    raise exception 'Only the transport office can send arrival alerts.';
  end if;

  foreach milestone in array array[15, 5] loop
    with due as (
      select t.id as trip_id, rs.id as stop_id,
             coalesce(h.name, s.name, 'the stop') as stop_name,
             -- S1: a reported delay shifts every remaining planned time, so a
             -- late van does not keep sending confidently wrong alerts.
             (t.date + rs.planned_arrival)::timestamptz
               + make_interval(mins => coalesce(t.delay_minutes, 0)) as due_at
      from daily_trips t
      join route_stops rs on rs.route_id = t.route_id
      left join hubs    h on h.id = rs.hub_id
      left join schools s on s.id = rs.school_id
      where t.date = current_date
        and t.status in ('scheduled', 'active')
        and rs.planned_arrival is not null
    ),
    ready as (
      select * from due
      -- Fires on the first pass at or after the milestone, and stops firing once
      -- the van is actually due. A cron tick every five minutes lands in here.
      where now() >= due_at - make_interval(mins => milestone)
        and now() <  due_at
    ),
    claimed as (
      insert into arrival_alerts (trip_id, stop_id, minutes)
      select trip_id, stop_id, milestone from ready
      on conflict do nothing
      returning trip_id, stop_id
    ),
    -- Who is actually still expecting this van here. Away students are excluded,
    -- which the local version never did.
    riders as (
      select c.trip_id, c.stop_id, sts.student_id, pr.full_name as student_name,
             r.stop_name, r.due_at
      from claimed c
      join ready r on r.trip_id = c.trip_id and r.stop_id = c.stop_id
      join student_trip_status sts
        on sts.trip_id = c.trip_id and sts.pickup_stop_id = c.stop_id
      join profiles pr on pr.id = sts.student_id
      where sts.status in ('scheduled', 'waiting')
    ),
    -- N1: one row per RECIPIENT per stop, listing whoever it covers. Two
    -- children at the same hub is one notification naming both.
    audience as (
      select gl.parent_id as user_id, r.stop_name, r.due_at,
             string_agg(distinct r.student_name, ' and ') as who
      from riders r
      join guardian_links gl on gl.student_id = r.student_id and gl.status = 'accepted'
      group by gl.parent_id, r.stop_id, r.stop_name, r.due_at
      union all
      select r.student_id, r.stop_name, r.due_at, null
      from riders r
    )
    insert into notifications (user_id, title, body, kind)
    select a.user_id,
           coalesce(a.who || '''s van', 'Your van') || ' is due in ' || milestone || ' minutes',
           'Expected at ' || a.stop_name || ' at ' || to_char(a.due_at, 'HH12:MI AM') || '.',
           'arrival'
    from audience a;

    get diagnostics batch = row_count;
    sent := sent + batch;
  end loop;

  return jsonb_build_object('ran', true, 'notifications', sent, 'at', now());
end;
$$;

grant execute on function send_arrival_alerts() to authenticated;

-- ---------------------------------------------------------------------------
-- S1 — a structured delay, so a late van's alerts stop being confidently wrong
--
-- `delay_minutes` and `delay_reason` have existed on daily_trips since the first
-- schema and NOTHING has ever written them. The driver's only delay path was a
-- free-text incident, which notifies parents and shifts nothing: every planned
-- time in the app carried on as if the van were on schedule.
-- ---------------------------------------------------------------------------

create or replace function report_delay(target_trip uuid, minutes int, reason text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t daily_trips%rowtype;
  route_name text;
  total int;
begin
  select * into t from daily_trips where id = target_trip;
  if t is null then
    raise exception 'That trip does not exist.';
  end if;
  if not (drives_trip(target_trip) or is_staff()) then
    raise exception 'Only the driver of this trip, or the transport office, can report a delay.';
  end if;
  if minutes is null or minutes <= 0 then
    raise exception 'A delay has to be a number of minutes.';
  end if;

  -- Cumulative. Twenty minutes of traffic followed by another ten is thirty, not
  -- ten — the driver is reporting what just happened, not restating the total.
  total := coalesce(t.delay_minutes, 0) + minutes;

  update daily_trips
  set delay_minutes = total,
      delay_reason  = coalesce(nullif(btrim(reason), ''), delay_reason)
  where id = target_trip;

  select rt.name into route_name from route_templates rt where rt.id = t.route_id;

  -- Everyone still expecting this van hears the new time for THEIR stop, not a
  -- generic "we are late".
  insert into notifications (user_id, title, body, kind)
  select a.user_id,
         route_name || ' is running ' || total || ' minutes late',
         'Now expected at ' || a.stop_name || ' about '
           || to_char(a.due_at, 'HH12:MI AM') || '.'
           || coalesce(' ' || nullif(btrim(reason), ''), ''),
         'delay'
  from (
    select gl.parent_id as user_id,
           coalesce(h.name, s.name, 'your stop') as stop_name,
           (t.date + rs.planned_arrival)::timestamptz + make_interval(mins => total) as due_at
    from student_trip_status sts
    join route_stops rs on rs.id = coalesce(sts.pickup_stop_id, sts.dropoff_stop_id)
    left join hubs    h on h.id = rs.hub_id
    left join schools s on s.id = rs.school_id
    join guardian_links gl on gl.student_id = sts.student_id and gl.status = 'accepted'
    where sts.trip_id = target_trip
      and sts.status not in ('absent', 'parent_pickup', 'no_show', 'dropped_off', 'completed')
      and rs.planned_arrival is not null
    union
    select sts.student_id,
           coalesce(h.name, s.name, 'your stop'),
           (t.date + rs.planned_arrival)::timestamptz + make_interval(mins => total)
    from student_trip_status sts
    join route_stops rs on rs.id = coalesce(sts.pickup_stop_id, sts.dropoff_stop_id)
    left join hubs    h on h.id = rs.hub_id
    left join schools s on s.id = rs.school_id
    where sts.trip_id = target_trip
      and sts.status not in ('absent', 'parent_pickup', 'no_show', 'dropped_off', 'completed')
      and rs.planned_arrival is not null
  ) a;

  -- Alerts already sent for this trip were based on the OLD time, so let the
  -- shifted ones fire again. This is the whole reason the delay is structured.
  delete from arrival_alerts where trip_id = target_trip;

  insert into audit_logs (entity_type, entity_id, action, new_value, reason, changed_by)
  values ('daily_trips', target_trip, 'delay_reported',
          jsonb_build_object('added', minutes, 'total', total),
          reason, auth.uid());

  return jsonb_build_object('delay_minutes', total);
end;
$$;

grant execute on function report_delay(uuid, int, text) to authenticated;

-- ---------------------------------------------------------------------------
-- S7 — "has it been past yet?"
--
-- The parent's most-asked question, and until now answerable only by opening the
-- app: `trip_stop_progress` writes were completely silent, and `in_transit` had
-- no notification at all despite appearing in the parent's timeline.
--
-- Departure from the child's OWN hub is the moment the answer changes, so that
-- is the only moment worth a push.
-- ---------------------------------------------------------------------------

create or replace function notify_on_stop_departure() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  stop_name text;
begin
  if new.departed_at is null then return new; end if;
  if tg_op = 'UPDATE' and old.departed_at is not null then return new; end if;

  select coalesce(h.name, s.name, 'the stop') into stop_name
  from route_stops rs
  left join hubs    h on h.id = rs.hub_id
  left join schools s on s.id = rs.school_id
  where rs.id = new.stop_id;

  -- Grouped per guardian (N1): a parent with two children on the same van gets
  -- one message naming both, not two pushes a second apart.
  insert into notifications (user_id, title, body, kind)
  select gl.parent_id,
         string_agg(distinct coalesce(nullif(pr.full_name, ''), 'Your child'), ' and ')
           -- Past simple reads correctly for one child or several; "has left"
           -- does not once the names are collapsed.
           || ' left ' || stop_name,
         'The van pulled away at ' || to_char(new.departed_at, 'HH12:MI AM') || '.',
         'in_transit'
  from student_trip_status sts
  join profiles pr on pr.id = sts.student_id
  join guardian_links gl on gl.student_id = sts.student_id and gl.status = 'accepted'
  where sts.trip_id = new.trip_id
    and sts.pickup_stop_id = new.stop_id
    and sts.status in ('boarded', 'in_transit')
  group by gl.parent_id;

  return new;
end;
$$;

create trigger on_stop_departed after insert or update on trip_stop_progress
  for each row execute function notify_on_stop_departure();

-- The arrival-alert sweep, as a switch. Same shape as the watchdog's.
create or replace function arrival_schedule_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  installed boolean;
  sched text;
begin
  select exists (select 1 from pg_extension where extname = 'pg_cron') into installed;
  if not installed then
    return jsonb_build_object('installed', false, 'enabled', false,
      'hint', 'pg_cron is not enabled. Supabase dashboard → Database → Extensions → enable pg_cron, then come back.');
  end if;
  execute $q$ select schedule from cron.job where jobname = 'arrival-alerts' $q$ into sched;
  return jsonb_build_object('installed', true, 'enabled', sched is not null, 'schedule', sched);
end;
$$;

create or replace function set_arrival_schedule(enable boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then
    raise exception 'Only the transport office can change the alert schedule.';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is not enabled on this project. Dashboard → Database → Extensions → enable pg_cron, then try again.';
  end if;

  if enable then
    -- Every two minutes: the 5-minute milestone needs finer resolution than the
    -- watchdog's five-minute tick or it lands late enough to be useless.
    execute $q$
      select cron.schedule('arrival-alerts', '*/2 6-19 * * 1-5', 'select send_arrival_alerts()')
    $q$;
  else
    begin
      execute $q$ select cron.unschedule('arrival-alerts') $q$;
    exception when others then null;
    end;
  end if;

  return arrival_schedule_status();
end;
$$;

grant execute on function arrival_schedule_status() to authenticated;
grant execute on function set_arrival_schedule(boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Scan boarding (attendance_mode = 'scan')
--
-- The student shows a QR code; the DRIVER scans it. Never the other way round.
-- A code posted on the bus that students scan themselves would be a
-- self-reported boarding, which is the one thing §2.1 forbids -- a child could
-- scan from the pavement and be recorded as aboard a van they missed. Because
-- the driver's phone does the scanning, the write is still a driver write, and
-- the RLS policies below are unchanged: scanning is a faster way to press
-- "Boarded", not a new authority to do it.
--
-- The driver's app already holds every rider on its own trip, so the normal
-- scan resolves locally with no round trip. This function exists for the scan
-- that DOESN'T resolve, which is the interesting one: a child at the right hub
-- holding a valid code for a different van. Without it the driver sees "unknown
-- code" and has no idea whether the app is broken or the child is on the wrong
-- bus. Security definer, because answering that question means reading a row
-- the caller deliberately cannot see.
-- ---------------------------------------------------------------------------

create or replace function identify_boarding_code(code text)
-- `route_kind` rather than `route_type`: an OUT column sharing a name with the
-- enum type is legal but becomes a plpgsql variable shadowing that type inside
-- the body, which is a trap for whoever edits this next.
returns table (
  student_name text,
  route_name   text,
  route_kind   route_type,
  driver_name  text,
  trip_date    date,
  is_today     boolean
)
language plpgsql security definer set search_path = public as $$
begin
  if not (is_staff() or my_role() = 'driver') then
    raise exception 'Only a driver or the transport office can identify a boarding code.';
  end if;

  return query
  select
    coalesce(nullif(sp.full_name, ''), 'A student'),
    rt.name,
    rt.type,
    coalesce(nullif(dp.full_name, ''), 'Not assigned'),
    t.date,
    t.date = current_date
  from student_trip_status sts
  join daily_trips t      on t.id = sts.trip_id
  join route_templates rt on rt.id = t.route_id
  join profiles sp        on sp.id = sts.student_id
  left join profiles dp   on dp.id = t.driver_id
  where sts.boarding_code = code
  limit 1;
end;
$$;

grant execute on function identify_boarding_code(text) to authenticated;

-- ---------------------------------------------------------------------------
-- C7 — "this student isn't on my list"
--
-- Scan mode can already name a child holding a valid code for another van
-- (identify_boarding_code above). MANUAL mode has nothing: RLS means driver B
-- cannot see student X at all, so a child boarding the wrong van is a no-show on
-- one and does not exist on the other. Nobody is told, by anybody.
--
-- This is the manual-mode equivalent: the driver types a name, and the database
-- answers the only question that matters — whose van should this child be on?
-- Security definer because answering it means reading rows the caller
-- deliberately cannot see, and it returns the NARROWEST possible answer: a name,
-- a route, a driver, a hub. No contact details, no address, nothing that is not
-- needed to get the child onto the right vehicle.
-- ---------------------------------------------------------------------------

create or replace function find_rider_today(search text)
returns table (
  status_id    uuid,
  student_name text,
  route_name   text,
  route_kind   route_type,
  driver_name  text,
  hub_name     text,
  rider_status rider_status,
  is_mine      boolean
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (my_role() in ('driver', 'coordinator', 'admin') and is_active()) then
    raise exception 'Only a driver or the transport office can look a rider up.';
  end if;
  if coalesce(btrim(search), '') = '' or length(btrim(search)) < 2 then
    raise exception 'Type at least two letters of their name.';
  end if;

  return query
  select sts.id,
         coalesce(nullif(p.full_name, ''), 'A student'),
         rt.name,
         rt.type,
         coalesce(nullif(dp.full_name, ''), 'No driver assigned'),
         coalesce(h.name, s.name, 'their stop'),
         sts.status,
         t.driver_id = auth.uid()
  from student_trip_status sts
  join daily_trips t on t.id = sts.trip_id
  join route_templates rt on rt.id = t.route_id
  join profiles p on p.id = sts.student_id
  left join profiles dp on dp.id = t.driver_id
  left join route_stops rs on rs.id = sts.pickup_stop_id
  left join hubs    h on h.id = rs.hub_id
  left join schools s on s.id = rs.school_id
  where t.date = current_date
    and p.full_name ilike '%' || btrim(search) || '%'
  order by (t.driver_id = auth.uid()) desc, p.full_name
  limit 10;
end;
$$;

grant execute on function find_rider_today(text) to authenticated;

/**
 * Move a rider onto the trip they are actually standing in front of.
 *
 * The driver cannot do this — deciding which van carries which child is the
 * office's call, and a driver quietly reassigning children is exactly the kind
 * of silent divergence this whole document is about. What the driver CAN do is
 * board them at a different stop on their own trip (below), and raise the
 * cross-van case so the office sees it.
 */
create or replace function move_rider_to_trip(status_id uuid, target_trip uuid, reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sts student_trip_status%rowtype;
begin
  if not is_staff() then
    raise exception 'Only the transport office can move a student between vans.';
  end if;
  if coalesce(btrim(reason), '') = '' then
    raise exception 'Moving a child to a different van needs a reason.';
  end if;

  select * into sts from student_trip_status where id = status_id;
  if sts is null then
    raise exception 'That student record no longer exists.';
  end if;

  update student_trip_status
  set trip_id = target_trip,
      -- The stops belong to the OLD route and mean nothing on the new one. The
      -- office re-seats them; leaving stale ids would put the child at a stop
      -- that is not on the van they are now on.
      pickup_stop_id = null,
      dropoff_stop_id = null,
      note = 'Moved between vans: ' || btrim(reason),
      updated_by = auth.uid(),
      updated_at = now()
  where id = status_id;

  insert into audit_logs (entity_type, entity_id, action, old_value, new_value, reason, changed_by)
  values ('student_trip_status', status_id, 'moved_trip',
          jsonb_build_object('trip_id', sts.trip_id),
          jsonb_build_object('trip_id', target_trip),
          btrim(reason), auth.uid());

  return jsonb_build_object('moved', true);
end;
$$;

grant execute on function move_rider_to_trip(uuid, uuid, text) to authenticated;

/**
 * Board a rider at a stop that is not the one they are assigned to.
 *
 * A child waiting at the wrong hub on the RIGHT van used to be unboardable: the
 * scanner would say "Priya boards at Oak Road, not here" and then offer nothing,
 * and the manual buttons only appear on their own stop's card. The driver takes
 * them anyway, and the record says they were never picked up.
 *
 * So it records what actually happened — boarded, at THIS stop — rather than
 * pretending the assignment was right.
 */
create or replace function board_at_other_stop(status_id uuid, actual_stop uuid, reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sts student_trip_status%rowtype;
  original text;
begin
  select * into sts from student_trip_status where id = status_id;
  if sts is null then
    raise exception 'That student record no longer exists.';
  end if;
  if not (drives_trip(sts.trip_id) or is_staff()) then
    raise exception 'Only the driver of this trip can board a student onto it.';
  end if;
  if coalesce(btrim(reason), '') = '' then
    raise exception 'Boarding a student at a different stop needs a note.';
  end if;

  select coalesce(h.name, s.name, 'their usual stop') into original
  from route_stops rs
  left join hubs    h on h.id = rs.hub_id
  left join schools s on s.id = rs.school_id
  where rs.id = sts.pickup_stop_id;

  update student_trip_status
  set status = 'boarded',
      pickup_stop_id = actual_stop,
      board_time = now(),
      note = 'Boarded at a different stop (usually ' || coalesce(original, 'elsewhere') || '): '
             || btrim(reason),
      updated_by = auth.uid(),
      updated_at = now()
  where id = status_id;

  return jsonb_build_object('boarded', true, 'moved_from', original);
end;
$$;

grant execute on function board_at_other_stop(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table organization        enable row level security;
alter table profiles            enable row level security;
alter table invites             enable row level security;
alter table schools             enable row level security;
alter table hubs                enable row level security;
alter table students            enable row level security;
alter table guardian_links      enable row level security;
alter table vehicles            enable row level security;
alter table vehicle_devices     enable row level security;
alter table route_templates     enable row level security;
alter table route_stops         enable row level security;
alter table route_assignments   enable row level security;
alter table daily_trips         enable row level security;
alter table student_trip_status enable row level security;
alter table trip_stop_progress  enable row level security;
alter table watchdog_alerts     enable row level security;
alter table arrival_alerts      enable row level security;
alter table change_requests     enable row level security;
alter table assignment_requests enable row level security;
alter table incidents           enable row level security;
alter table announcements       enable row level security;
alter table notifications       enable row level security;
alter table audit_logs          enable row level security;
alter table vehicle_locations   enable row level security;
alter table invoices            enable row level security;
alter table account_removals    enable row level security;

-- organization: every ACTIVE user reads (the app needs the feature flags).
create policy "read org" on organization for select using (is_active());
create policy "admins write org" on organization for update
  using (is_admin()) with check (is_admin());

-- profiles
create policy "read own profile" on profiles for select using (id = auth.uid());
create policy "parents read children" on profiles for select using (is_guardian_of(id));
create policy "students read parents" on profiles for select using (is_child_of(id));
create policy "drivers read their riders" on profiles for select using (drives_student(id));
-- Blueprint §4.1: the student's Today screen shows the driver's first name, and
-- §4.2 gives the parent the same. So a rider (and their guardian) may read the
-- profile of whoever is driving a trip they are actually on today — and nobody
-- else's.
create policy "riders read their driver" on profiles for select using (
  exists (
    select 1
    from daily_trips t
    join student_trip_status sts on sts.trip_id = t.id
    where t.driver_id = profiles.id
      and t.date = current_date
      and (sts.student_id = auth.uid() or is_guardian_of(sts.student_id))
  )
);
create policy "staff read all profiles" on profiles for select using (is_staff());
create policy "update own profile" on profiles for update
  using (id = auth.uid()) with check (id = auth.uid());
create policy "admins update profiles" on profiles for update
  using (is_admin()) with check (is_admin());
create policy "admins delete profiles" on profiles for delete using (is_admin());

-- invites
--
-- No policy for the person redeeming one: a signed-out user cannot read this
-- table at all, and reaches it only through invite_details(), which takes an
-- exact code and returns one row. A blanket read policy here would hand out
-- every unused code in the school.
--
-- Only ADMINS may issue invites, not coordinators — an invite is how a person
-- gets a role, so issuing one is the same power as assigning a role, and RLS
-- draws that line in the same place it does on `profiles`.
create policy "admins issue invites" on invites for all
  using (is_admin()) with check (is_admin());
create policy "coordinators see invites" on invites for select using (is_staff());

-- Reference data: readable by any ACTIVE signed-in user, written by staff.
-- `is_active()` rather than `to authenticated`: a suspended account still holds a
-- valid session, so "authenticated" would keep letting them read the whole route
-- and hub list.
create policy "read schools" on schools for select using (is_active());
create policy "staff write schools" on schools for all using (is_staff()) with check (is_staff());

create policy "read hubs" on hubs for select using (is_active());
create policy "staff write hubs" on hubs for all using (is_staff()) with check (is_staff());

create policy "read vehicles" on vehicles for select using (is_active());
create policy "staff write vehicles" on vehicles for all using (is_staff()) with check (is_staff());

create policy "admins read device keys" on vehicle_devices for select using (is_admin());
create policy "admins write device keys" on vehicle_devices for update
  using (is_admin()) with check (is_admin());

create policy "read routes" on route_templates for select using (is_active());
create policy "staff write routes" on route_templates for all using (is_staff()) with check (is_staff());

create policy "read route stops" on route_stops for select using (is_active());
create policy "staff write route stops" on route_stops for all using (is_staff()) with check (is_staff());

-- students
create policy "students read own record" on students for select
  using (student_id = auth.uid() and is_active());
create policy "guardians read child record" on students for select using (is_guardian_of(student_id));
create policy "drivers read rider record" on students for select using (drives_student(student_id));
create policy "staff manage students" on students for all using (is_staff()) with check (is_staff());
-- Blueprint §4.1: the student Profile screen is READ-ONLY in the MVP. Hubs and
-- school are set by staff, not chosen by the student.

-- guardian_links
create policy "read own links" on guardian_links for select
  using ((is_active() and (parent_id = auth.uid() or student_id = auth.uid())) or is_staff());
create policy "propose link" on guardian_links for insert
  with check (
    is_active()
    and requested_by = auth.uid()
    and (parent_id = auth.uid() or student_id = auth.uid())
  );
create policy "accept link" on guardian_links for update
  using ((parent_id = auth.uid() or student_id = auth.uid()) and requested_by <> auth.uid())
  with check (parent_id = auth.uid() or student_id = auth.uid());
create policy "remove link" on guardian_links for delete
  using (parent_id = auth.uid() or student_id = auth.uid() or is_staff());
create policy "staff link families" on guardian_links for insert with check (is_staff());

-- route_assignments
create policy "read own assignments" on route_assignments for select using (
  (is_active() and (student_id = auth.uid() or is_guardian_of(student_id)))
  or is_staff()
);
create policy "staff write assignments" on route_assignments for all
  using (is_staff()) with check (is_staff());

-- daily_trips: drivers see ONLY their own (blueprint §2.1).
create policy "drivers read own trips" on daily_trips for select
  using (is_active() and driver_id = auth.uid());
create policy "staff read all trips" on daily_trips for select using (is_staff());
create policy "riders read their trip" on daily_trips for select using (
  is_active() and exists (
    select 1 from student_trip_status sts
    where sts.trip_id = daily_trips.id
      and (sts.student_id = auth.uid() or is_guardian_of(sts.student_id))
  )
);
create policy "drivers update own trips" on daily_trips for update
  using (is_active() and driver_id = auth.uid())
  with check (is_active() and driver_id = auth.uid());
create policy "staff write trips" on daily_trips for all using (is_staff()) with check (is_staff());

-- student_trip_status
create policy "read own status" on student_trip_status for select using (
  (is_active() and (student_id = auth.uid() or is_guardian_of(student_id)))
  or drives_trip(trip_id)
  or is_staff()
);

-- A STUDENT may only ever move themselves to `waiting` — never to boarded or
-- dropped_off. This is the blueprint's core safety rule, enforced in the
-- database so no client bug or hostile request can get round it.
--
-- N2: `checkin_window_min` has existed since the first schema with NOTHING
-- behind it — a student could check in at 3am, and the driver would arrive at a
-- hub to a `waiting` flag set eight hours ago by someone still in bed. Enforced
-- here rather than in the client, for the same reason as everything else on this
-- table: the client is not the thing that decides.
create policy "students check in only" on student_trip_status for update
  using (is_active() and student_id = auth.uid())
  with check (
    is_active()
    and student_id = auth.uid()
    and status = 'waiting'
    and within_checkin_window(trip_id, pickup_stop_id)
  );

-- The driver is the official record for boarding and drop-off.
create policy "drivers record outcomes" on student_trip_status for update
  using (drives_trip(trip_id))
  with check (
    drives_trip(trip_id)
    and status in ('boarded', 'in_transit', 'dropped_off', 'no_show',
                   'absent', 'parent_pickup', 'unable_to_drop_off')
  );

create policy "staff override status" on student_trip_status for all
  using (is_staff()) with check (is_staff());

-- trip_stop_progress: the driver of the trip writes it; staff read everything;
-- a rider (or their guardian) reads the progress of a trip their child is on.
create policy "drivers manage stop progress" on trip_stop_progress for all
  using (drives_trip(trip_id)) with check (drives_trip(trip_id));
-- `for all`, not `for select`. This was read-only, which meant a coordinator
-- could not fix a mistapped departure AT ALL — the only tool was `rerun_trip`,
-- which is admin-only and wipes the entire trip's history to correct one tap.
create policy "staff manage stop progress" on trip_stop_progress for all
  using (is_staff()) with check (is_staff());
create policy "riders read stop progress" on trip_stop_progress for select using (
  is_active() and exists (
    select 1 from student_trip_status sts
    where sts.trip_id = trip_stop_progress.trip_id
      and (sts.student_id = auth.uid() or is_guardian_of(sts.student_id))
  )
);

-- watchdog_alerts: the office's own queue. Nobody else reads it — the rows name
-- children and say where they were last seen, and the families already get told
-- what concerns them through notifications. The watchdog itself writes as the
-- table owner from inside transport_watchdog(), so no insert policy is needed.
create policy "staff manage watchdog alerts" on watchdog_alerts for all
  using (is_staff()) with check (is_staff());

-- arrival_alerts is pure bookkeeping — which alerts have already gone out. The
-- families see the notifications themselves; nobody needs to read the ledger.
create policy "staff read arrival alerts" on arrival_alerts for select using (is_staff());

-- change_requests
create policy "read own changes" on change_requests for select using (
  (is_active() and (student_id = auth.uid() or is_guardian_of(student_id)))
  or is_staff()
);
create policy "request a change" on change_requests for insert with check (
  is_active()
  and requested_by = auth.uid()
  and (student_id = auth.uid() or is_guardian_of(student_id))
);
create policy "staff decide changes" on change_requests for all
  using (is_staff()) with check (is_staff());

-- assignment_requests: a guardian proposes and tracks changes for their own
-- child; staff see and act on all. The apply-on-approval happens inside
-- review_assignment_request(), so there is no client-side write of the students
-- table here.
create policy "read own assignment requests" on assignment_requests for select using (
  (is_active() and is_guardian_of(student_id)) or is_staff()
);
create policy "propose assignment change" on assignment_requests for insert with check (
  is_active() and requested_by = auth.uid() and is_guardian_of(student_id)
);
create policy "cancel own pending assignment" on assignment_requests for delete using (
  requested_by = auth.uid() and status = 'pending'
);
create policy "staff manage assignment requests" on assignment_requests for all
  using (is_staff()) with check (is_staff());

-- incidents
create policy "drivers report incidents" on incidents for insert
  with check (is_active() and driver_id = auth.uid());
create policy "read relevant incidents" on incidents for select using (
  is_staff()
  or (is_active() and driver_id = auth.uid())
  or (is_active() and exists (
    select 1 from student_trip_status sts
    where sts.trip_id = incidents.trip_id
      and (sts.student_id = auth.uid() or is_guardian_of(sts.student_id))
  ))
);
create policy "staff resolve incidents" on incidents for update
  using (is_staff()) with check (is_staff());

-- announcements
create policy "read announcements" on announcements for select using (is_active());
create policy "staff post announcements" on announcements for all
  using (is_staff()) with check (is_staff());

-- notifications
create policy "read own notifications" on notifications for select
  using (is_active() and user_id = auth.uid());
create policy "mark own read" on notifications for update
  using (is_active() and user_id = auth.uid())
  with check (is_active() and user_id = auth.uid());
create policy "staff send notifications" on notifications for insert with check (is_staff());

-- audit_logs: staff read only, nobody writes directly (triggers do).
create policy "staff read audit" on audit_logs for select using (is_staff());

-- switched-off features
create policy "read locations" on vehicle_locations for select using (
  is_staff() or (is_active() and exists (
    select 1 from daily_trips t
    where t.vehicle_id = vehicle_locations.vehicle_id
      and t.date = current_date
      and (
        t.driver_id = auth.uid()
        or exists (
          select 1 from student_trip_status sts
          where sts.trip_id = t.id
            and (sts.student_id = auth.uid() or is_guardian_of(sts.student_id))
        )
      )
  ))
);
create policy "drivers write locations" on vehicle_locations for insert with check (
  is_active() and exists (
    select 1 from daily_trips t
    where t.vehicle_id = vehicle_locations.vehicle_id
      and t.driver_id = auth.uid()
      and t.status = 'active'
  )
);

create policy "read own invoices" on invoices for select using (
  (is_active() and (student_id = auth.uid() or is_guardian_of(student_id)))
  or is_staff()
);
create policy "staff manage invoices" on invoices for all
  using (is_staff()) with check (is_staff());

create policy "staff read removals" on account_removals for select using (is_staff());

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table student_trip_status;
alter publication supabase_realtime add table trip_stop_progress;
alter publication supabase_realtime add table daily_trips;
alter publication supabase_realtime add table notifications;
alter publication supabase_realtime add table change_requests;
alter publication supabase_realtime add table vehicle_locations;
