---
name: barebone
description: Build or extend the barebone alternative to the full Student Transportation Platform — a passive bus-watching app (login for parents/students/admins, admin assigns bus and stops, live vehicle location, 15-and-5-minute alerts, at-stop notification, no driver role). All its code lives in /Users/amitpathak/Developer/bus-tracking-app-lite. Use when the user says "barebone", "bare essential", "bare version", "lite version", "the alt version", or asks to build or change bus-tracking-app-lite.
---

# Barebone bus tracker

The alternative to the full app in this repo. The full version is a
**custody-of-children system**: nine rider statuses, driver-confirmed boarding,
an end-of-trip checklist the database enforces, a watchdog, QR scanning, a weekly
archive-and-purge. It answers *"where is my child, and who has them."*

This one answers **one question only: where is the bus, and when does it reach my
stop.** It never claims to know where a child is. That is the whole design, and
every scope decision below follows from it.

> ## 🛑 Where the code goes — read this before touching anything
>
> **Every file this skill produces belongs in
> `/Users/amitpathak/Developer/bus-tracking-app-lite/`.** No exceptions.
>
> **`bus-tracking-app/` is READ-ONLY for all lite work.** Open its files to read
> and port *from*; never edit one, never add one, never update its docs to
> describe a lite feature. If you find yourself editing anything under
> `bus-tracking-app/` while working on lite, you have made a mistake — stop and
> move the change to the lite directory.
>
> ### Why this is confusing, and the one exception
>
> This skill file physically lives in the FULL repo
> (`bus-tracking-app/.claude/skills/barebone/SKILL.md`) purely because
> `docs/FEATURES.md` there links to it, so the reader of the full app's docs can
> find out that an alternative exists. **That link is the only relationship
> between the two projects.** The skill living there does not make the lite work
> belong there.
>
> The full app's `docs/FEATURES.md` already carries a one-time pointer saying lite
> exists. That pointer is **finished**. Do not extend it, do not add lite
> features to it, and do not add lite entries to the full app's `CHANGELOG.md`.
> Lite gets its own — see **Lite has its own documentation** below.
>
> **Status: framework only. Nothing is built** — no schema, no app code. Do not
> create any until the user says to start. When they do, follow **Build order**
> below and stop at the end of the phase they asked for.

## The four locked decisions

Settled with the user on 13 August 2026. Do not relitigate these; if the user
wants one changed they will say so, and then update this file.

| | Decision | Why it matters downstream |
| --- | --- | --- |
| **Codebase** | A **sibling project**, `/Users/amitpathak/Developer/bus-tracking-app-lite`, parallel to `bus-tracking-app`. Not a branch, not a flag. | The full app stays untouched. Nothing is deleted, so nothing can break. Copy code across deliberately, never by inheritance. |
| **Location source** | A **hardware GPS tracker in the van**, POSTing `{device_key, lat, lng}` over HTTPS. | This is what makes "no driver" coherent — no human has to remember to open an app. Port `supabase/functions/ingest-location/index.ts` from the full app; it already does exactly this. |
| **Trip model** | **None.** No route templates, no daily trip generation, no cron. A bus, an ordered list of stops, and live GPS. | Everything is derived from the live fix. Kills roughly half the remaining complexity: no `ensure_daily_trips()`, no planned-vs-actual, no timezone-sensitive wall-clock comparisons. |
| **What families can do** | **Nothing but watch.** See the bus, see minutes away, get three notifications. | No check-in, no statuses, no absence reporting. Nothing the app can get *wrong about a child.* |

## The whole product, in six lines

1. Parents, students and admins sign in.
2. An admin creates buses and stops, and puts stops in order on a bus.
3. An admin assigns each student to a bus and one stop on it — and can mark
   stops the student does **not** use.
4. A tracker in the van reports its position; parents and students see it move
   on a map, with minutes-away to *their* stop.
5. Notifications at **15 minutes away** and **5 minutes away**.
6. A notification when **the bus is at the stop**.

That is the product. If a proposed feature is not on this list, it does not go
in without the user asking for it by name.

## What is deliberately absent

Carry this table into every design conversation about the lite app. The failure
mode for this project is quietly rebuilding the full one.

| Full app has | Lite | Reason |
| --- | --- | --- |
| Driver role, driver screens, trip start/end | ✗ | The premise. There is no driver in the app at all. |
| Nine rider statuses, the transition state machine | ✗ | Nothing tracks children. There is no rider row to have a status. |
| Boarding confirmation, QR / `attendance_mode` | ✗ | Follows from the above. |
| End-of-trip checklist, "every student ends with a final status" | ✗ | No trips, no custody claims. |
| The watchdog (`transport_watchdog()`, `pg_cron`) | ✗ | It watches a schedule. There is no schedule. |
| Route templates, `ensure_daily_trips()` | ✗ | Replaced by an ordered stop list on the bus. |
| Change requests, cutoffs, absence, club routes | ✗ | Families are passive. |
| Coordinator role, exception queue, announcements | ✗ | Two staff roles collapse to one **admin**. |
| Incidents, audit log viewer, weekly report + purge | ✗ | Nothing generates the volume that justified them. GPS breadcrumbs still need a retention rule — see **Still open**. |
| Payments, invoices | ✗ | Off in the full app too. |
| Invite-code signup with role on the invite | **Keep** | The one piece of the full app's auth model worth every line. Nobody picks their own role. |
| Row Level Security on every table | **Keep** | Non-negotiable. See **Rules** below. |
| Live GPS behind `gps_enabled` | **Keep, always on** | It is the product here, not a flag. |

Five roles become **three**: `admin`, `parent`, `student`.

## The shape of the data

A sketch to design against — **not a schema to write yet.** Around seven tables
against the full app's twenty-five.

```
organization      one row: name, timezone, alert thresholds
profiles          id → auth.users, role (admin|parent|student), active
invites           single-use code carrying the role  (port from full app)

buses             label, plate, active
bus_devices       bus_id → device_key   (secret, its own table — see Rules)
stops             name, lat, lng, geofence_radius_m
bus_stops         bus_id, stop_id, position   ← the ordered route
student_stops     student_id, bus_id, stop_id, uses_it boolean
guardian_links    parent ↔ student
bus_locations     bus_id, lat, lng, heading, speed, recorded_at
alerts_sent       bus_id, stop_id, milestone, sent_at   ← the de-dup key
```

Two notes carried over from the full app because they were learned the hard way:

- **`device_key` lives in its own table**, never on `buses`. RLS is row-level,
  not column-level, and every signed-in student can read the bus list.
- **`alerts_sent` is keyed on the stop, not the student.** Two children at one
  stop must produce one notification naming both, not two identical ones a
  second apart. That is how a family learns to swipe alerts away unread.

## The three notifications

The entire alerting model. All of it derives from the live fix — there is no
planned time to compare against.

| Milestone | Condition | Fires |
| --- | --- | --- |
| 15 minutes | ETA to the stop ≤ 15 min | once per bus per stop per run |
| 5 minutes | ETA to the stop ≤ 5 min | once per bus per stop per run |
| At the stop | Bus within the stop's geofence (default 100 m) | once per bus per stop per run |

Rules that make it survive contact with a real van:

- **ETA follows the route, not the crow.** Distance along the remaining ordered
  stops, not straight-line to the target. `src/lib/eta.ts` in the full app
  already does this — read it before writing a new one.
- **Every milestone fires at most once**, and only for the stops still ahead of
  the bus. A bus that reverses, or a fix that jitters backwards, must not
  re-fire an alert already sent.
- **"Run" needs defining without trips.** Provisionally: a gap of N minutes with
  no fix ends a run and clears `alerts_sent` for that bus. Confirm with the user
  before implementing — it is listed under **Still open**.
- **Distinguish *parked* from *signal lost*.** The full app solved this with a
  90-second heartbeat from a stationary vehicle. A tracker that has gone quiet
  must show as *"last seen 6 minutes ago"*, never as a bus sitting still.

## The location pipeline

```
tracker in van  ──POST {device_key, lat, lng}──▶  ingest-location  (Edge Function)
                                                        │ device_key → bus_id
                                                        ▼
                                                  bus_locations
                                                        │ Supabase Realtime
                                                        ▼
                                     parent / student map + ETA + alert check
```

`ingest-location` authenticates on the `device_key` alone — trackers cannot hold
a session — so it runs with the service role and the key lookup *is* the
authorization. Port the full app's version, but **strip the trip lookup**: it
queries a `trips` table that will not exist here.

## The layout to build

**Mirror the full app's structure exactly. Same shape, same file names, same
conventions — just with things removed.** A developer who knows one project
should be able to find their way around the other blind. Do not invent a new
architecture, a new directory scheme, or new naming just because the app is
smaller: the whole point of a sibling project is that porting stays mechanical.

That means the same `app/` route groups with expo-router, the same
`src/lib` + `src/components` split, the same `supabase/` layout with
`schema.sql` and `functions/`, the same `.env.example` convention, the same
`AGENTS.md`. Where the full app has a thing lite also needs, it goes in the same
place with the same name.

```
Developer/
  bus-tracking-app/          ← the full app. READ ONLY for this work.
  bus-tracking-app-lite/     ← everything below gets written here
    README.md                  what this is, how to run it, how it differs
    CHANGELOG.md               its own, starting at the first commit
    AGENTS.md                  same Expo-57 rule as the full app
    docs/
      FEATURES.md              what lite does and deliberately does not
    .env.example
    app/
      _layout.tsx          role guard
      sign-in.tsx  sign-up.tsx
      (parent)/    map, stops, notifications
      (student)/   map, my stop
      (admin)/     buses, stops, students, invites
    src/
      lib/supabase.ts  auth.tsx  eta.ts  push.ts   ← port, then cut
      components/Map.tsx  Map.web.tsx              ← port
    supabase/
      SETUP.md
      schema.sql
      functions/ingest-location/
```

## Lite has its own documentation

**The lite project keeps its own full documentation set**, in the same shape as
the full app's. It is a product, not a scratch build:

| File | Contents |
| --- | --- |
| `README.md` | What it is, how to run it, and a short table of how it differs from the full app |
| `CHANGELOG.md` | Its own history, newest first, starting from the first commit. **Never add lite entries to the full app's changelog** |
| `docs/FEATURES.md` | What lite does, and — just as important — the explicit list of what it deliberately does not, so nobody rebuilds the full app by accident |
| `supabase/SETUP.md` | Its own setup: project, schema, invite bootstrap, tracker `device_key`, push |

Write each of these **as the phase that creates the thing lands**, not in one lump
at the end. A `CHANGELOG.md` written retrospectively is fiction.

The full app's docs describe the full app and nothing else. The single pointer in
its `docs/FEATURES.md` saying lite exists is already written and is the complete
extent of cross-referencing.

Porting means **copy the file across and then delete what the lite app does not
need** — not import from the sibling directory, and not edit it in place. The two
projects share no code at runtime; a fix in one does not reach the other, which
is the trade accepted when the user chose a separate project over a branch.

**Port and cut** (they carry weight the lite app still needs): `supabase.ts`,
`auth.tsx` (minus approval states), `eta.ts`, `push.ts`, `Map.tsx` / `Map.web.tsx`,
`session-storage.ts`, `ui.tsx`, and the invite half of the schema.

**Do not port**: `tracking.ts` (that is driver-phone streaming — the tracker
replaces it), `BoardingScanner`, `BoardingPass`, `StudentAssignment`,
`WeeklyReports`, `VanEta` (rewrite it smaller), `Disabled.tsx`, the watchdog,
retention, and every trip-related function.

## Build order

Each phase ends somewhere demoable. Stop at the end of whichever the user asked
for; do not run ahead.

1. **Scaffold** — Expo 57 project, expo-router, Supabase client, three route
   groups, a role guard that compiles and runs empty screens. Scaffold **into**
   the existing `bus-tracking-app-lite/` directory rather than letting
   `create-expo-app` make a nested one, and keep the README already there.
   Also create the documentation set in this phase: `CHANGELOG.md`,
   `docs/FEATURES.md`, `AGENTS.md`, `.env.example` — mirroring the full app's
   layout, per **The layout to build**.
2. **Auth** — invite-code signup, the three roles, RLS on `profiles`.
3. **Admin config** — CRUD for buses, stops, the ordered `bus_stops` list, and
   student→bus→stop assignment with the opt-out flag.
4. **Location in** — `ingest-location` deployed, plus a simulator script that
   drives a fake bus along a route so everything downstream is testable without
   hardware.
5. **The map** — live bus over stops, realtime subscription, minutes-away, and
   *last seen* when the tracker goes quiet.
6. **The three notifications** — ETA milestones, geofence entry, `alerts_sent`
   de-dup, Expo push. Port the full app's push lessons rather than rediscovering
   them: an EAS `projectId` in `app.json` (without it no token is ever issued),
   separate Android channels so the routine pings can be muted without muting the
   rest, and a delivery state recorded per notification.

**Every phase ends by updating `CHANGELOG.md` and `docs/FEATURES.md` in the lite
project.** Not the full app's.

Phases 1–3 need no hardware. Phase 4's simulator means 5 and 6 do not either.

## Rules while building

- **Read the Expo 57 docs before writing code** — `https://docs.expo.dev/versions/v57.0.0/`.
  This repo's `AGENTS.md` says Expo has changed, and it means it.
- **RLS from the first table, not retrofitted.** A parent reads only their linked
  children's bus; a student reads only their own. Test it by querying the
  database directly as each role with the app out of the loop — that is how the
  full app found a suspended account whose session still worked.
- **Never claim to know where a child is.** No screen, notification, or column
  may imply boarding, presence, or custody. "The bus is at your stop" is a fact
  about a vehicle; "your child is on the bus" is one this app cannot know.
- **The `device_key` is a password.** Never in `EXPO_PUBLIC_*`, never on a table
  a student can read, rotatable.
- Single organisation, same as the full app. One `organization` row.
- **Mirror the full app's structure**, do not reinvent it. Same directory shape,
  same file names, same conventions — with things removed, never rearranged.
- **Store the operation's timezone from the first schema.** The full app shipped
  without it and every wall-clock comparison was silently four hours out. Lite
  has no planned times today, but the moment anything compares a clock this
  matters, and retrofitting it touched five functions.
- **Never edit the full app.** Covered at the top, repeated here because it is the
  one mistake that is expensive to unpick.

## Still open

Ask the user when the phase that needs it comes up — not before.

1. **What ends a "run"** and resets `alerts_sent`? A quiet-period timeout is the
   provisional answer; a morning/afternoon direction flag is the alternative.
2. **Do stops have times at all?** Currently no. Without them the app cannot say
   "the bus is late", only "12 minutes away".
3. **GPS breadcrumb retention.** Highest-volume table by far, and the full app's
   purge is not coming across. Needs a rule, even a crude one.
4. **Which tracker hardware**, and does it push to an HTTPS endpoint directly or
   through a vendor platform that needs a poller instead?
5. **Web build?** The full app ships web for the office. Lite may not need it —
   though admin config work at a desk is the same argument.
