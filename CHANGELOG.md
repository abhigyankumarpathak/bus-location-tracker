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

## 10 August 2026

### 16:37 — Turn on scanning and the live map, add holiday absences, and batch the school drop-off

Not committed yet — working tree.

A design review of the ride flow came first (see
[docs/REMEDIATION.md](docs/REMEDIATION.md) for what it found and what is still
outstanding). Four things were built off the back of it.

**Morning arrival at school is now one tap, and names the exceptions**

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
