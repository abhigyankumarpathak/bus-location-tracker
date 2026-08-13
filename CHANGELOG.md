# Changelog

Every change to the Student Transportation Platform, in order, with the date and
time it landed.

Entries up to and including **16 July 2026** are taken from the git history —
each one is a real commit, and the timestamp is that commit's author date
(local time).

Each entry gives the commit subject followed by **what actually changed**, read
from the diff. Some of the early subjects are `changes`, `readme` and `smtn`,
which tell you nothing a month later; the summary is the useful part.

Newest first.

---

## 13 August 2026

### A barebone alternative, specified

Nothing in the application changed. What landed is a **specification for a second,
much smaller product**, and a note in [FEATURES](docs/FEATURES.md) saying it
exists.

The full platform is a custody-of-children system: nine rider statuses, driver-
confirmed boarding, an end-of-trip checklist the database refuses to skip, a
watchdog on the clock. The alternative answers **one question** — *where is the
bus, and when does it reach my stop* — and deliberately answers nothing else.

Kept: sign-in for parents, students and admins; invite codes that carry the role;
an admin assigning each student a bus and a stop, and marking the stops they do
not use; RLS on everything.

Gone: **the driver role entirely**, and with it rider statuses, boarding
confirmation, QR scanning, the end-of-trip checklist, trips, route templates, the
watchdog, change requests, the coordinator role, incidents, and the weekly purge.
Five roles become three. Around twenty-five tables become seven.

The live position comes from **a GPS tracker fitted to the van**, not a phone —
which is what makes "no driver" coherent, since no human has to remember to open
anything. `ingest-location` already accepts exactly that POST and comes across
largely unchanged. There are **no trips and no schedule**: a bus, an ordered list
of stops, and three notifications derived from the live fix — 15 minutes away,
5 minutes away, and *the bus is at your stop*.

It is a **separate project** — `bus-tracking-app-lite/`, a sibling directory to
this one, created empty today — not a branch and not a feature flag, so this
codebase is untouched and nothing here is switched off. Choosing it is choosing a
different product: it never claims to know where a *child* is, only where a
*vehicle* is.

It **mirrors this project's layout** — same `app/` route groups, same
`src/lib` + `src/components` split, same `supabase/` shape — with things removed
rather than rearranged, so porting stays mechanical. And it keeps **its own
README, CHANGELOG, FEATURES and SETUP**: lite changes never appear in this
changelog, and this repo is read-only for that work. The single pointer in
[FEATURES](docs/FEATURES.md) is the entire relationship between the two.

Written up in [`.claude/skills/barebone/SKILL.md`](.claude/skills/barebone/SKILL.md)
as an invocable skill, with the scope boundary, the data sketch, the alerting
rules, a six-phase build order, and five questions still open. **No code, no
schema, no project directory yet** — say the word and it starts at phase 1.

---

## 12 August 2026

### The vans are not in UTC

Found while working out why a live database showed no watchdog activity. Supabase
runs the database in UTC. `planned_arrival` and `planned_departure` are `time`
columns — wall-clock times for the operation, with no zone attached — and every
comparison against them resolved in the *database's* timezone.

For an operation running in New York that is a **four-hour error**, and it hit
four things simultaneously:

- the watchdog decided every morning route was hours overdue before the day
  began, and would never have noticed a genuinely late afternoon one;
- "your van is due in 15 minutes" fired overnight;
- the change-request cutoff was judged against the wrong clock;
- the check-in window opened and closed at the wrong times.

A 07:15 pickup was being evaluated as **03:15 New York time**.

`organization.time_zone` now holds the operation's zone and every comparison goes
through `local_ts()`. Settable in **Setup → Watchdog**, with a warning while it is
still on the UTC default, because UTC is what you get by not choosing rather than
a choice anyone made. Region names only — `America/New_York` follows daylight
saving, `EST` is a fixed −05:00 and wrong all summer.

**Both cron schedules widened** for the same reason. They ran `6-19 * * 1-5`,
which is in the database's timezone: on a UTC project that is 02:00–15:59 in New
York, missing the afternoon run entirely. They now run all day. That costs
nothing — the watchdog is naturally silent when nothing is scheduled, so the
window was buying noise reduction that was never needed and a timezone bug that
was.

The end-to-end day now runs under both settings and shows the difference: 36/36
with the zone set correctly, and a failing arrival-alert assertion when it is
wrong — which is the fix demonstrably doing something.

### A whole day, end to end — and the bug that only that could find

Every guard built over the last two sessions had been tested on its own. This
runs the **morning and afternoon of one school day** against a real Postgres, in
the order the app makes the calls, as the roles that make them: trip generation,
a parent reporting an absence after the wall-clock cutoff, a check-in, the
15-minute alerts, a refused departure and then an allowed one, the `in_transit`
promotion, the batch drop-off, completion, the watchdog on a clean day and on a
trip that never ended, boarding a student recorded as absent, an undo, a
cross-van lookup, a delay, and the state of the record afterwards.

**36 assertions, on three install paths** — a fresh `schema.sql`, a clean install
from the patches, and an upgrade of a database that had already applied the
earlier ones. All passing.

**The bug it found.** C4 requires a note before a student recorded as absent can
be boarded. The check was “the note is not empty” — but `note` is a single column
shared by every path that writes the row, and `apply_change_request()` already
puts the **absence reason** in it. So a child marked absent with the reason
“Ill.” could be boarded with no explanation at all, and the parent notification
would then have read:

> **“Ill. Boarded at 3:42 PM.”**

— presenting the reason the child was marked absent as the driver's explanation
for carrying them. The guard now requires the note to be non-empty **and changed
by this write**. A note that has not changed is not an explanation for this
action.

Every piece was correct in isolation. The defect only existed where a parent's
absence reason and a driver's boarding note met in the same column, which is
exactly what an end-to-end run is for.

**A second ordering bug, found by the same run:** patch 2 re-installed its own
copy of that function *over* patch 1's, so fixing patch 1 alone silently did
nothing. Both patch files now carry the corrected version, and
`2026-08-12c-stale-note.sql` fixes a database that already applied the first two.

### The watchdog runs without cron now

`pg_cron` is a Supabase extension somebody has to enable by hand, and until they
do, **nothing checks the clock** — which for the one feature whose entire job is
noticing silence is the worst possible default.

The staff app now sweeps too: the Dashboard and Exceptions tabs call
`transport_watchdog()` and `send_arrival_alerts()` on focus, throttled to once
every two minutes. Same belt-and-braces pattern as `ensureTodaysTrips`, and both
functions dedupe server-side so repeated calls cost a query and change nothing.

This is a **floor, not a substitute**. It only runs while somebody has the app
open, which is precisely the assumption the watchdog exists to remove. `pg_cron`
is still the answer.

`verify.sql` also now checks that the C4 guard is the *fixed* version, not merely
that the function exists — a distinction no existence check would catch.

### Push notifications that actually arrive, and a real split between “wrong” and “happened”

Prompted by two answers to the plan's open questions: **nobody watches the
coordinator dashboard during a run**, and **drivers use personal phones**.
Together those mean the exception queue is a record rather than a delivery
mechanism, and the office finds out about a problem only if a notification
reaches a device nobody controls the settings of.

**Push was silently dead. The cause was one missing line.**

- `app.json` had no `extra.eas.projectId`, so `getExpoPushTokenAsync()` threw on
  every launch, a bare `catch` swallowed it, `registerForPush` returned `null`,
  and **no device ever stored a push token**. Every notification the system has
  ever generated went to the in-app inbox and nowhere else.
- Nothing anywhere reported this. Not the user, not the office, not a log.
- `registerForPush` now returns a typed reason instead of `null`, and a
  `<PushStatus/>` banner on the student, parent and driver home screens says
  which of the three requirements is missing — in words the person reading it
  can act on. It says nothing at all when push is working.

**Arrival alerts now ring.**

- `send-push` sent `sound: null` and `priority: 'normal'` for everything except
  emergencies — so “your van is due in 15 minutes”, whose entire job is *start
  walking now*, arrived as a silent banner on a phone in a pocket. Arrival and
  delay alerts are now sound + high priority: not urgent, but **time-critical**,
  and one that lands after the van has gone is worse than none.
- Urgent kinds get `interruptionLevel: 'time-sensitive'` on iOS, so a Focus mode
  cannot silence “could not drop off” — exactly when someone most needs
  interrupting.

**Three Android notification channels instead of one.**

`urgent`, `arrivals` and `default`. One channel for everything means a family
who mutes the routine pings also mutes the child-unaccounted-for one. `send-push`
routes each message to the right channel by kind.

**Tapping a notification goes somewhere.** A response listener routes to the
inbox (where urgent messages can be acknowledged) or to the driver's run.
Previously a push just reopened the app wherever it was last left.

**The staff Exceptions tab is now two tabs.**

It had become one scroll containing emergencies, routine approvals and a
notification feed — which meant the emergencies got scrolled past.

- **Exceptions** — only what is *wrong*, ordered by how bad it is if nobody
  looks: a child still on a van, a child who checked in and was then not picked
  up, what the watchdog noticed that no human reported, students with no outcome,
  no-shows, **messages that were not delivered**, and open incidents.
- **Notifications** — the stream: the office's own feed, plus approvals waiting
  on a decision, plus announcements already sent. Nothing here means anything is
  broken.

Exceptions sits first in the tab bar, because a stream can wait.

**Also:** the seven open questions in the remediation plan now have six answers
recorded in [docs/REMEDIATION.md](docs/REMEDIATION.md), with what each one
changes about the build. The one still open — the jurisdiction's record-keeping
requirement for child transport custody — is flagged as a live risk against the
weekly purge, which currently deletes routine ride detail after three weeks.

### The rest of the remediation plan — everything except C3

Twenty-one of the review's twenty-two findings are now closed. Applied as
`supabase/patches/2026-08-12b-c2-c5-c6-c7-c8-and-the-s-n-series.sql` and folded
into `schema.sql`. Both files were loaded into a real Postgres and exercised
against seeded trips; the patch was also tested as an upgrade from the previous
released schema, twice, to confirm it is idempotent.

**C2 — the watchdog. The only thing here that watches the clock.**

- Every other escalation in this system fires because a driver tapped something.
  If the phone dies, is pocketed, or the driver stops tapping, the trip stayed
  `active` for ever and **nobody was told anything**.
- `transport_watchdog()` runs every five minutes during operating hours (pg_cron,
  switch in Setup → Watchdog) and raises six things: a route that never started,
  a van overdue at a stop, a child still `waiting` at a hub, a trip running past
  any plausible maximum, a child still aboard after the van reached its last
  stop, and an urgent notification nobody has acknowledged.
- Each breach alerts **once** — an expression index does the deduplication,
  because a plain unique constraint treats NULLs as distinct and would have
  re-raised every single pass.
- Alerts **clear themselves** when the condition goes away. A queue full of
  resolved-in-reality alerts is a queue nobody reads.
- Thresholds live on `organization`, adjustable in Setup. A rural route with a
  forty-minute gap between hubs needs different patience from a town run.
- Open alerts sit at the **top** of the coordinator's exception queue, above
  everything a human reported, because they are the only items there that arrived
  without a human noticing first.

**C5 — undo, and a correction path that does not need an admin**

- A mistapped `no_show` was terminal: the card rendered with no actions and the
  only way out was a coordinator, mid-route, from a desk.
- `undo_rider_status()` and `undo_stop_progress()` read the previous state out of
  the audit log and write a **compensating** entry — the log reads "this
  happened, then it was taken back" rather than quietly ceasing to mention it.
- The buttons appear for 90 seconds and then disappear on their own, because
  offering an undo the database will refuse is worse than not offering one.
- Undoing a departure also puts everyone it promoted back to `boarded`.
- Staff RLS on `trip_stop_progress` widened from `for select` to `for all`. A
  coordinator genuinely could not fix a mistapped departure at all before this;
  the only tool was `rerun_trip`, which is admin-only and wipes the whole trip.

**C8 — what may follow what**

- RLS checked who may write which status and never what may follow what, so a raw
  call with a driver's token could move a rider `scheduled → dropped_off`. The UI
  was the only thing preventing it, which contradicted the README's claim that
  these are database rules.
- `guard_rider_transition()` holds the table; anything not in it is refused. It is
  written down in [docs/FEATURES.md](docs/FEATURES.md).
- Staff stay exempt (§2.1 already demands a reason from them), and so does an
  explicit undo — a compensating action is not a forward move, and enumerating
  every reverse edge would have doubled the table and turned it into noise.

**C6 + S1 + S7 + N1 — one pass over the notification path**

- Arrival alerts were **local notifications scheduled on the device**, which
  failed four ways at once and none of them observably: they only existed if the
  app had been opened that day; web got nothing; the scheduling effect re-ran on
  every render, calling `cancelAllScheduledNotificationsAsync()` globally each
  time; and away students were alerted anyway.
- `send_arrival_alerts()` now inserts `notifications` rows from cron. That buys
  push, the in-app inbox, web, and a queryable record. `src/lib/alerts.ts` is
  deleted.
- **S1:** `delay_minutes` and `delay_reason` have been on `daily_trips` since the
  first schema and nothing ever wrote them. `report_delay()` gives the driver
  +10/+15/+30, shifts every remaining planned time, tells each family the new time
  **for their own stop**, and re-arms the shifted alerts.
- **S7:** guardians are told when the van leaves their child's hub — the parent's
  most-asked question, previously answerable only by opening the app.
- **N1:** a parent with two children at one hub gets **one** message naming both,
  for arrival alerts and departure alerts alike.

**C7 — manual mode catches up with scan mode**

- `find_rider_today()`: the driver types a name and learns whose van that child
  belongs on. Without it, a child on the wrong van was invisible to everybody —
  RLS means driver B cannot see student X, so they were a no-show on one van and
  did not exist on the other.
- It returns the narrowest possible answer: a name, a route, a driver, a hub. No
  contact details, no address.
- `board_at_other_stop()`: a child at the wrong hub on the *right* van used to be
  unboardable — the scanner refused and the manual buttons live on a card that
  only renders under their own stop. Now it records what actually happened.
- `move_rider_to_trip()` is staff-only. Which van carries which child is the
  office's call, not something a driver should be able to change quietly.

**The S and N series**

- **S2** — a `no_show` after a check-in now escalates differently from one out of
  nothing. The first means the child said they were there and then were not picked
  up; it gets its own urgent wording and its own section in the exception queue.
- **S4** — the cutoff was a wall clock when what matters is the trip boundary.
  Between 06:30 and the van pulling away an absence sat `pending`, so the driver
  waited for a child who was never coming and then filed a no-show that alarmed
  everyone. Now auto-approved any time before that child's trip actually starts,
  hard-frozen once it has.
- **S5** — roster generation added but never removed, so a student taken off a
  route stayed on today's trip and blocked the driver from ending it. `scheduled`
  rows with no matching assignment are deleted; anything further along is a real
  record of a real child and is never touched.
- **S6** — push had no delivery record at all: a user with no token produced no
  row, no retry and no trace, so "we sent it" was unfalsifiable. Every outcome is
  now recorded on the notification. The two urgent kinds require a person to
  acknowledge them, and the watchdog escalates silence to the office.
- **S8** — `ensure_daily_trips` was `security definer` and executable by every
  authenticated user, so any student could materialise trip rows for an arbitrary
  date. Revoked; `ensure_todays_trips()` is the narrow wrapper the apps call.
- **N2** — `checkin_window_min` had nothing behind it. A student could check in at
  3am and the driver would find a `waiting` flag eight hours stale. Enforced in the
  student's RLS policy.
- **N3** — the audit log has a viewer (the History tab), with filters and search.
  Read-only by construction: no policy on that table lets anyone write to it.
- **N4** — cutoff times and the check-in window are in Setup, done after S4 as the
  plan instructed, with copy that explains what they now mean.
- **N5** — announcements were fanned out **from the client** to every active
  student, parent and driver regardless of who the message was about. Moved into a
  trigger that respects `route_id`, so "Route 2 is delayed" no longer wakes every
  family on every other van.

**Found while doing the above**

- `select coalesce(…) into` does nothing when the select matches no row, leaving
  the variable NULL — which nulled an entire incident description via `||`. Fixed
  in two places.
- The watchdog would have raised a false alarm on **every afternoon run**: the
  school is the origin of an afternoon route, which the driver never marks an
  arrival at. That is the fastest way to teach a coordinator to ignore alerts.
- Grammar: "Arun and Priya **has** left Oak Road" once the names were collapsed.

**Still open: C3, the offline queue.** Deliberately. The plan sequences it last
"once the safety work is not waiting on it", which is now true — and with the
watchdog in place a driver who goes silent in a dead zone is at least *noticed*.
It is the one item the plan calls a genuine project, and an outbox with wrong
ordering or idempotency rules is worse than none in an app about where children
are.

### Phase 1 of the remediation plan: C4, C1 and S9

Three items from [docs/REMEDIATION.md](docs/REMEDIATION.md), in the order that
document sequences them. All three are cases where a child could end up on, or
off, a van with nobody told.

**C4 — a student marked absent who turns up can now be boarded**

- `absent`, `parent_pickup` and `no_show` are all final, so the driver saw **no
  buttons** for a child standing in front of them. The only way out was a
  coordinator override, mid-route, from a desk. What actually happened is that
  the driver took the child — of course they did — and the record said the van
  was not carrying a child it was carrying.
- New **“Boarding anyway — turned up”** on any away status, at that student's
  pickup stop. A note is required.
- The note is required by the **database**, not just the screen:
  `guard_boarding_after_away()` refuses the write without one. It lands in
  `audit_logs.reason` and in the notification body.
- Guardians *and* the coordinator are told, in different words from a routine
  boarding (“Priya boarded after being recorded as absent”), under a distinct
  notification kind `boarded_after_away`. The office is holding the absence
  request this just contradicted.
- The scanner now points at this button instead of saying “use the roster”.

**C1 — departing a stop with somebody unaccounted for**

- `markDeparted` promoted only `boarded` riders. A student who tapped *“I'm at
  the hub”* and was never boarded stayed `waiting` while the van pulled away, and
  **nothing fired** — the catch was End trip, potentially forty minutes and eight
  stops later.
- The question End trip asks is now asked at every departure, where the van is
  still at the kerb. `guard_stop_departure()` refuses the write; the app holds it
  first and lists exactly who, with Boarded / No-show / Absent (or Dropped off /
  Unable to drop off) **inline**, rather than sending the driver back up the
  screen.
- The driver is never stuck. `departed_with_unresolved` leaves anyway — a van
  that cannot move is its own safety problem. It just stops being free:
  `record_forced_departure()` files an incident **per child** and their guardians
  and the office are notified immediately.
- `riders_unresolved_at_stop()` holds the rule once, for the guard and the
  incident recorder; `unresolvedAtStop()` in `src/lib/types.ts` mirrors it so the
  warning names the same people the database would refuse on.

**S9 — stop-progress integrity**

- `check (departed_at >= arrived_at)`, with the trigger raising a readable
  sentence before the constraint name ever reaches the driver.
- A second **Arrived** tap no longer moves the recorded time. Staff still can —
  that correction path is C5 — but the driver's app cannot overwrite its own
  history.
- Explicit `skipped` boolean instead of inferring “skipped” from a null arrival.
  “Deliberately skipped” and “the arrival was never recorded” are different facts
  about a child.

**Two things found while doing it**

- `notify_on_incident()` broadcast every incident's description to every guardian
  on the route. With C1 filing per-child incidents that would have told every
  family who was left behind, by name. An incident carrying a `student_id` now
  goes to that student's guardians only; coordinators still get everything.
- `schema.sql` could not be re-run: `trip_stop_progress` and
  `assignment_requests` were missing from the drop list at the top, so they
  survived the drop with their old columns and the create failed halfway through.
  Both added.

**Applying it**

`supabase/schema.sql` is canonical but destructive.
`supabase/patches/2026-08-12-c4-c1-s9.sql` is the same change as alters, safe on
a live database. Both were loaded into a real Postgres and exercised — refusal,
override, notification routing, audit reason, and the staff-vs-driver correction
paths.

---

## 10 August 2026

### 17:09 · `438cb70` — Turn on QR boarding and the live map, add holiday absences, batch the school drop-off

A design review of the ride flow came first (see
[docs/REMEDIATION.md](docs/REMEDIATION.md) for what it found and what is still
outstanding). Four things were built off the back of it.

**S3 — morning arrival at school is now one tap, and names the exceptions**

- The driver gets **“All N dropped off safely”** at any stop where two or more
  riders are still on board — in practice, the morning arrival at school.
- Exceptions are marked *first* and the count falls as they are. So the record
  says who did **not** get off, instead of asserting that everyone did.
- Every rider still gets their own row, their own timestamp, and their own parent
  notification. This is one write, not one outcome.
- Deliberately **not** applied to boarding. Bulk-marking children as present is a
  claim about who is physically there; bulk-marking them off at a school gate is
  not. Afternoon boarding is answered by scanning instead.

**Holiday absences — one request, not twenty**

- `change_requests.end_date` (nullable; null means a single day).
- `ensure_daily_trips`, `apply_change_request` and the club-cancellation branch
  all read the span as `date .. coalesce(end_date, date)`.
- Only the **first** day is judged against the cutoff, so a holiday booked in
  advance is always in time.
- Parent screen gets a **One day / Holiday** toggle, validates both dates before
  the database has to, and shows the span as “12 Aug – 30 Aug · 19 days”.
- Spans now render wherever a request is listed: parent, student club, staff
  exception queue, and the approve/reject notification.

**QR boarding, on both legs of the day**

- `attendance_mode = 'scan'` is now real rather than reserved.
- `student_trip_status.boarding_code`, defaulted from a new
  `new_boarding_code()`. Per trip row, so it differs morning and afternoon and
  yesterday's screenshot is worthless.
- Student sees their code on Today, one per leg, hidden once they are on board.
- Driver gets **“Scan students on”** per stop, once the van has arrived there.
- **The driver scans the student, never the reverse.** A code the student scanned
  themselves would be a self-reported boarding — the one thing §2.1 forbids,
  because a child can scan from the pavement and then miss the van. The write
  stays a driver write and no RLS policy changed.
- New `identify_boarding_code()` RPC so a code that does not belong to this trip
  gets a real answer — *“Priya rides Route 2 with Sam, not this van”* — instead of
  “unknown code”. That also gives wrong-vehicle detection in scan mode.
- Manual boarding stays available underneath. A flat phone has no QR and the van
  still has to leave.

**The live map, from the driver's phone**

- `gps_enabled` now drives a real feature end to end. Previously the tracking
  module was written but **never called from any screen** — nothing wrote a
  position.
- Driver: tracking starts on **Start trip**, stops on **End trip**, and the trip
  screen shows plainly whether the van is sharing, limited to the foreground, or
  off.
- Parent: live ETA on each child's card, and the van on the route map.
- Student: live ETA to their own stop, plus a map.
- ETA comes from the van's actual position, so these screens can say **“6 minutes
  away”** — the scheduled 15/5-minute alerts can only ever say “due in”, and stay
  confidently wrong when the van is late. Both now coexist and are worded
  differently on purpose.
- A stale fix (>4 min) is never shown as live; the screens say the van has gone
  quiet instead of leaving a pin that reads as “parked here”.
- Position comes from the driver's phone today. The `ingest-location` endpoint
  takes the same rows from a tracker fitted to the van when one exists, and
  nothing above that line changes when it does.

**Location is only ever collected while a route is running**

Four independent guards, because one is not enough — a driver who forgets to tap
**End trip** must not be tracked home:

1. Start is tied to starting a trip. Nothing else calls it.
2. Opening the driver's home screen stops a task left over from a forgotten
   *End trip* (`enforceTrackingScope`).
3. The background task stops **itself**: a six-hour ceiling, and it treats the
   database refusing a row as authoritative — the RLS policy only accepts a
   position for an `active` trip, so a refusal means the route is over.
4. The database is the backstop. No position can be stored outside an active trip
   the caller is driving.

A **stationary van goes quiet**: reporting is triggered by movement (30 m) with a
90-second heartbeat, instead of a fix every 10 seconds.
`pausesUpdatesAutomatically` was `false` — explicitly opting out of the platform's
own stationary detection — and is now `true`, with
`activityType: AutomotiveNavigation`.

**Also**

- `tracking.web.ts` and `BoardingScanner.web.tsx` added, matching the existing
  platform-split pattern — Metro resolves imports at build time, so a runtime
  `Platform.OS` check cannot keep `expo-task-manager` or the camera out of the web
  bundle.
- New: `BoardingPass`, `BoardingScanner`, `VanEta`, `useVehicleLocation`,
  `stopsStillToVisit`, `formatDateSpan`.
- Copy corrected in three places that still claimed scanning and GPS were not
  built: `Setup → Features`, `GpsDisabled`, and the `attendance_mode` schema
  comment.
- `identify_boarding_code`'s output column is `route_kind`, not `route_type` — an
  OUT column sharing a name with the enum becomes a PL/pgSQL variable shadowing
  that type.

*Verified:* `tsc --noEmit` clean; schema checked structurally (dollar-quote
balance, function definition order, no missed single-date comparisons). The schema
was **not** executed — no credentials for a Postgres to run it against.

---

## 17 July – 9 August 2026 — paused

**25 days, no commits.** The bus company cancelled, so work stopped and the
project sat untouched.

Nothing was abandoned mid-change: the tree was clean at `dcfdb98`, and the pause
falls between the July work and the 10 August session above rather than through
the middle of anything.

---

## 16 July 2026

**21:07** · `dcfdb98` — *“smtn”*
Added `docs/SCAN-NFC-VS-QR.md` (126 lines): a written comparison of NFC against
QR for student check-in. No code. This is the thinking behind the
`attendance_mode` flag added the day before, and the reason 10 August shipped QR
rather than NFC.

## 15 July 2026

**22:34** · `fc842e3` — Make Setup deletes work on web, and label trip delete as one-day
Delete buttons in the staff portal used a confirmation that never resolves in a
browser, so on web nothing happened when you pressed them. Replaced across
`setup.tsx`, and the trip-delete wording was corrected to say it removes one
day's trip, not the route.

**22:17** · `1fd9cb0` — Stop an empty stop from blocking the driver's arrive/depart sequence
Each stop unlocked only when the previous one was departed, but stops with nobody
on them are hidden from the driver's roster. A hidden stop could never be
departed, so every stop after it was stuck on “Not reached yet” with no Arrived
button — the route could not be worked. The sequence now walks only the stops the
driver can actually see.

**15:07** · `19498a9` — Add an attendance-mode toggle: manual now, NFC/QR reserved
`organization.attendance_mode` (`manual` | `scan`) with an admin toggle. At this
point it recorded intent only and changed no behaviour. Made real on 10 August.

**14:56** · `90f4f67` — Mark the hub, not the school, as “your stop” on the parent map
Five lines. The map starred whichever stop was the child's pickup, which on an
afternoon route is the school — so every parent's “your stop” pin was the school.

**14:40** · `433e0e5` — Let a parent request a hub/school change, for the office to approve
New `assignment_requests` table, `review_assignment_request()` RPC, a
`StudentAssignment` component, and a staff approval queue. Unlike a daily change
this alters the standing assignment, so there is no cutoff and no auto-approval —
a person always decides. Approval applies all three fields in one transaction, so
the client never writes the `students` table.

**14:19** · `c482836` — Give the driver stop-by-stop arrive/depart, and the parent a live “van arrived”
The largest behavioural change of the July work. New `trip_stop_progress` table:
one row per stop the van reaches, holding when it arrived and when it pulled away.
Replaced a single trip-wide “Vehicle departed” button, so `in_transit` now fires
when the van leaves *that child's* hub rather than for everyone at once — and the
parent gets a concrete “🚌 Van arrived at Oak Road at 07:19”.

**14:02** · `04f942b` — Show the parent their child's hub, not the school
Added `hubStopId()` — a route stop is a hub XOR the school, so the hub is
whichever of pickup/drop-off is not the school. Fixes the same
direction-flip bug as `90f4f67`, on the child cards.

**13:51** · `660be64` — Show boarding at the pickup stop and drop-off at the drop-off stop, not both
A student sits at two stops on a route. The driver screen was rendering the full
action set at both, so a boarded student showed “Dropped off safely” at their
pickup hub as well as at school.

**13:45** · `a84224b` — Make deleting a trip actually stick
Deleted trips came back. `ensure_daily_trips()` rebuilds the day from every active
template and inserts `on conflict (route_id, date) do nothing` — a real DELETE
freed that slot, so the next screen focus recreated the trip. Now it cancels
instead: the row survives to hold the slot, and the board hides it.

**13:31** · `6aa68bb` — Let an admin re-run or delete a trip, on the record
`rerun_trip()` and `delete_trip()`. Both admin-only, both refuse without a
reason — enforced in the database, not the UI, so it cannot be skipped by calling
the API directly — and both write to `audit_logs`.

## 14 July 2026

**13:15** · `4b9cf9a` — Let a student actually see, and accept, a parent's link request
A parent could send a guardian link request and the student had no way to see it.
Added the RLS policy letting a student read requests naming them, and reused
`FamilyLinks` on the student profile instead of its own cut-down version.

**10:23** · `74ec744` — Stop showing a spent invite code as if it still works
The invite list showed used, expired and revoked codes identically to live ones,
so staff would read out a dead code.

**00:31** · `ccc48ec` — Make the deployment build actually installable
Deployment build fixes: `serve` moved into real dependencies (it was only
available in dev) and the Replit run command corrected.

**00:06** · `443ce90` — Name the parent's actions after what they DO, not what they cause
The parent's button said “Absent”, which is what the child *becomes*, not what the
parent *does* — it read like a toggle on the child rather than a message to the
school. Renamed to “Report absence” and each option now states the resulting
status explicitly.

## 13 July 2026

**23:58** · `778c9a2` — Fix the white screen on the parent Map tab (web)
`expo-maps` has no web implementation and blew up on import, so the tab rendered
blank before it could show its own fallback. Added `Map.web.tsx`, which Metro
resolves first on web, drawing the route as an ordered list of stops instead.

**23:15** · `f859dd4` — Addresses instead of coordinates, and a parent route map
Staff enter a street address and `geocode.ts` resolves it, rather than asking for
lat/lng. Added the parent route map screen.

**23:02** · `ea01d28` — 15- and 5-minute arrival alerts, and a place to put the real stop details
`alerts.ts`: local notifications scheduled from each stop's `planned_arrival`.
Deliberately *not* GPS-derived — the honest claim is “your van is due in 15
minutes”, not “is 15 minutes away”. (The 10 August review flagged the delivery
mechanism here as the weakest part of the notification path; see
[REMEDIATION C6](docs/REMEDIATION.md).)

**21:27** · `31f74c4` — Record the driver and van in the weekly report
So “who was driving my child that day” survives the purge, including substitutes.

**18:33** · `cd65474` — Mention the weekly purge in the FEATURES summary
Docs only.

**17:12** · `4987021` — Replit: serve the static export on port 5000, so the preview works
Third and final Replit fix: build a static export and serve it on the port Replit
actually exposes.

**16:49** · `aa46404` — Replit: stop the xdg-open crash, and restore the Run button
Expo tried to open a browser in a container that has none.

**16:28** · `69a93c1` — Make .replit parse: plain ASCII, no angle brackets
The config file would not parse. Moved the prose into `REPLIT.md`.

**16:23** · `8d09b96` — Keep expo-sqlite out of the web bundle (fixes the white screen)
The web build died on SQLite's WASM worker. A runtime `Platform.OS` check does not
help — Metro resolves imports at build time — so this introduced the
`.web.ts` sibling pattern (`session-storage.ts` / `.web.ts`) that the codebase
still uses for every native-only module.

**15:52** · `10ec994` — Make the weekly purge a switch in the admin portal
`retention_weeks` became a setting rather than a constant.

**15:08** · `c4247d5` — Document the weekly report and purge, and link FEATURES from the README
Docs only.

**15:02** · `28c18c3` — Weekly report to families, then purge what is routine
Nothing in the blueprint asked for this. Every Sunday a student's week is archived
into one `weekly_reports` row and sent to the family; only then is the routine
detail behind it deleted. The report **is** the history, so the purge compacts a
child's record rather than erasing it — and incidents, no-shows and overrides are
never purged.

**13:39** · `cd14e43` — Refetch staff and rider screens on focus, not just on mount
Tabs stay mounted, so a mount-only fetch never refreshed. Eight screens showed
stale data indefinitely once you had visited them.

**11:08** · `b7cdfc3` — Run on Replit, and put the button on the README
First Replit attempt: config, nix deps, and a preflight script.

## 12 July 2026

**23:21** · `856afe1` — Give each realtime subscriber its own channel
Supabase returns the *same* channel object for a given topic name. Two mounted
screens using the same hook collided on one channel and the second threw
“cannot add postgres_changes callbacks after subscribe()”. A per-instance id
keeps each subscriber separate.

**23:13** · `3f74285` — Add a full route editor to the staff portal
739 lines into `setup.tsx`: hubs, vans, routes, stops with planned times, and
which students ride them.

**22:07** · `e997871` — Add expo-dev-client so `expo start` opens the app, not Expo Go
Native modules do not run in Expo Go, so a dev build is required.

**19:32** · `9f5c68f` — Rebuild as the MVP Functional Blueprint's transportation platform
The real beginning: 56 files, ~11,600 lines. Replaced the hello-world app with the
whole platform — Postgres schema with RLS, all role screens, four Edge Functions,
invite-based signup, and the nine-state rider model.

**14:46** · `4b720f0` — *“readme”*
Added the initial README (81 lines) to the hello-world app. Superseded by the
rewrite later the same day.

**14:36** · `9ee3436` — *“changes”*
Wrapped the hello-world screen in `SafeAreaProvider` from
`react-native-safe-area-context`, replacing React Native's built-in `SafeAreaView`
so the layout respects the notch. One dependency, one component. Nothing else.

## 11 July 2026

**14:06** · `77379bc` — Hello world Expo app with iOS development build
Project scaffold: Expo app, icons, `app.json`, tsconfig. A tap counter and a bus
emoji.

---

## Keeping this file

Add the new entry at the top under a date heading, with the time it landed. For a
commit, use the commit's own timestamp and short hash so this file and
`git log` can never disagree.
