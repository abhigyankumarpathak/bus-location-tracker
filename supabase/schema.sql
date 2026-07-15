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

drop table if exists
  audit_logs, notifications, announcements, incidents, change_requests,
  student_trip_status, daily_trips, route_assignments, route_stops,
  route_templates, invoices, vehicle_locations, vehicle_devices, vehicles,
  guardian_links, students, hubs, schools, account_removals, invites, profiles,
  organization cascade;

drop type if exists
  user_role, account_status, route_type, trip_status, rider_status,
  change_kind, approval_status, incident_kind, incident_severity,
  invoice_status, location_source cascade;

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

-- ---------------------------------------------------------------------------
-- Organisation + feature flags
-- ---------------------------------------------------------------------------

create table organization (
  id                 int primary key default 1 check (id = 1),
  name               text not null default 'School Transport',
  logo_url           text,

  -- Blueprint §1.2 excludes continuous GPS from the first release, and §8
  -- ("Do not continuously write vehicle GPS coordinates in the first release")
  -- says to add it only after measuring cost and battery. The code is fully
  -- written and tested; this flag is what keeps it out of the pilot.
  gps_enabled        boolean not null default false,

  -- Blueprint §1.2 excludes payments/invoicing. Same story: built, switched off.
  payments_enabled   boolean not null default false,

  -- Blueprint §4.2: changes before the cutoff are automatic; later ones need a
  -- coordinator to approve them.
  morning_cutoff     time not null default '06:30',
  afternoon_cutoff   time not null default '13:30',

  -- Blueprint §4.1: check-in is only allowed within a window before the trip.
  checkin_window_min int not null default 60
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
  updated_by    uuid references profiles on delete set null,
  updated_at    timestamptz not null default now(),
  unique (trip_id, student_id)
);
create index sts_trip_idx on student_trip_status (trip_id);
create index sts_student_idx on student_trip_status (student_id);

-- Blueprint §4.2 / §6.3. A parent (or student, for club) asks for a change.
-- Before the cutoff it applies immediately; after it, a coordinator decides.
create table change_requests (
  id               uuid primary key default gen_random_uuid(),
  student_id       uuid not null references profiles on delete cascade,
  date             date not null,
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
  route_id   uuid references route_templates on delete cascade,
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
  created_at timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id, created_at desc);

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
    left join lateral (
      select kind from change_requests c
      where c.student_id = ra.student_id
        and c.date = target_date
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
            and c.date = target_date
            and c.kind = 'club_attending'
            and c.approval in ('auto_approved', 'approved')
        )
      )
    on conflict (trip_id, student_id) do nothing;
  end loop;

  return created;
end;
$$;

grant execute on function ensure_daily_trips(date) to authenticated;

-- ---------------------------------------------------------------------------
-- Change requests: auto-approve before cutoff, queue after it
-- ---------------------------------------------------------------------------

create or replace function decide_change_request() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  org organization%rowtype;
  cutoff timestamptz;
begin
  select * into org from organization where id = 1;

  -- Morning cutoff governs absence; afternoon governs pickup and club changes.
  cutoff := (new.date + case
    when new.kind = 'absent' then org.morning_cutoff
    else org.afternoon_cutoff
  end)::timestamptz;

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
             || ' — ' || new.kind::text || ' for ' || new.date::text || '.',
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
      and t.date = new.date
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
      and t.date = new.date
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
      title := student_name || ' boarded the vehicle';
      body  := 'Confirmed by the driver at ' || when_txt || '.';
      select array_agg(parent_id) into audience from guardian_links
      where student_id = new.student_id and status = 'accepted';

    when 'dropped_off' then
      title := student_name || ' was dropped off safely';
      body  := 'Confirmed by the driver at ' || when_txt || '.';
      select array_agg(parent_id) into audience from guardian_links
      where student_id = new.student_id and status = 'accepted';

    when 'no_show' then
      title := student_name || ' did not appear at the hub';
      body  := 'The driver recorded a no-show at ' || when_txt || '.';
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
    select distinct u, title, body, new.status::text
    from unnest(audience) as u
    where u is not null;
  end if;

  return new;
end;
$$;

create trigger on_rider_status_change after update on student_trip_status
  for each row execute function notify_on_rider_status();

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

  insert into audit_logs (entity_type, entity_id, action, old_value, new_value, reason, changed_by)
  values ('daily_trips', target_trip, 'rerun', before,
          jsonb_build_object('status', 'scheduled'), trimmed, auth.uid());
end;
$$;
grant execute on function rerun_trip(uuid, text) to authenticated;

-- Remove a trip entirely. student_trip_status rows cascade with it. The audit
-- row is written BEFORE the delete, capturing what was there, because after the
-- delete there is nothing left to point at.
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

  insert into audit_logs (entity_type, entity_id, action, old_value, new_value, reason, changed_by)
  values ('daily_trips', target_trip, 'delete', before, null, trimmed, auth.uid());

  delete from daily_trips where id = target_trip;
end;
$$;
grant execute on function delete_trip(uuid, text) to authenticated;

-- Delay reported -> affected parents (blueprint §6.2).
create or replace function notify_on_incident() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  route_name text;
begin
  select rt.name into route_name
  from daily_trips t join route_templates rt on rt.id = t.route_id
  where t.id = new.trip_id;

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
alter table change_requests     enable row level security;
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
create policy "students check in only" on student_trip_status for update
  using (is_active() and student_id = auth.uid())
  with check (is_active() and student_id = auth.uid() and status = 'waiting');

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
alter publication supabase_realtime add table daily_trips;
alter publication supabase_realtime add table notifications;
alter publication supabase_realtime add table change_requests;
alter publication supabase_realtime add table vehicle_locations;
