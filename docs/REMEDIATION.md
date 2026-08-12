# Remediation plan

A design review on 10 August 2026 stress-tested the morning and afternoon ride
flow against this codebase and found **22 problems**, graded by consequence rather
than effort. This is the plan to close them.

Two things to know before reading:

- **The flow document the review was given was behind the code.** Three of its
  open questions were already settled here — per-stop drop-off, student check-in
  being firewalled from boarding, and empty-stop skipping. Those are not in this
  plan because they are not problems.
- **Four items were already closed** by the 10 August session. The 12 August
  session closed **everything else except C3**. There is a full checklist at the
  bottom of this document; the per-item sections below are kept for the reasoning.

Severity is about what happens if it is wrong, not how long it takes to fix.
**Safety** marks a path where a child can be unaccounted for and nobody is told.

---

## Already closed — 10 August 2026

| | Was | Now |
| --- | --- | --- |
| **S3** | Morning arrival at school was one “dropped off safely” tap per child — up to 30 taps carrying no information, training the rapid tap-through that would make the afternoon's per-child confirmations unreliable. | One **“All N dropped off safely”**, with exceptions marked first so the record names who did *not* get off. Individual rows, timestamps and notifications are unchanged. |
| **C7** *(partly)* | A child boarding the wrong van was invisible: RLS means driver B cannot see student X, so the child was a no-show on one van and did not exist on the other. | In scan mode, `identify_boarding_code()` names it: *“Priya rides Route 2 with Sam, not this van.”* Wrong **stop** is now reported clearly but still not boardable. **Manual mode still has neither** — see C7 below. |
| — | `gps_enabled` gated a tracking module that no screen ever called. Nothing wrote a position. | Wired end to end, with four independent guards keeping collection inside a running route and a stationary van reporting on movement rather than continuously. |
| — | A month's holiday was twenty separate absence submissions. | One request with an `end_date`. |

---

## Already closed — 12 August 2026

Phase 1's C1 and Phase 2's C4, plus S9, which folded into C1 as planned. Applied
as `supabase/patches/2026-08-12-c4-c1-s9.sql` and folded into `schema.sql`.

| | Was | Now |
| --- | --- | --- |
| **C4** | `isFinal('absent')` meant the driver saw **no buttons** for a child standing in front of them, on any away status. The only route out was a coordinator override from a desk. So the driver took the child and the record said absent. | **“Boarding anyway — turned up”** on any away status. `guard_boarding_after_away()` refuses the write without a note — the database, not the screen. Guardians *and* the coordinator are told, in different words from a routine boarding, under kind `boarded_after_away`. |
| **C1** | `markDeparted` promoted only `boarded` riders. A student who tapped *“I'm at the hub”* stayed `waiting` while the van pulled away, and nothing fired until **End trip**, eight stops later. | Two-phase departure. `guard_stop_departure()` refuses it; the app holds the write first and offers *Boarded / No-show / Absent* inline. `departed_with_unresolved` still leaves — a driver must be able to keep driving — but files an incident **per child** and notifies their guardians and the office immediately. |
| **S9** | Nothing enforced `departed_at >= arrived_at`, a re-tapped arrival overwrote the original time, and skipped-vs-served was inferred from a null. | Both check constraints; the trigger raises a sentence before the constraint name reaches the driver. A driver cannot overwrite a recorded time (staff still can — that is C5). Explicit `skipped` boolean. |
| — | `notify_on_incident()` broadcast every incident's description to every guardian on the route. C1's per-child incidents would have named the left-behind child to every other family. | An incident carrying a `student_id` goes to that student's guardians only. Coordinators still get everything. |
| — | `schema.sql` could not be re-run: `trip_stop_progress` and `assignment_requests` were missing from the drop list, so they survived with old columns and the create failed halfway through. | Both added to the drop list. |

---

## Phase 1 — the silent failures

**Why first:** these are the only two items where a child can end up unaccounted
for and *no human is told at all*. Everything else in this plan is worse data or a
harder job. These two are worse outcomes. Both are small, and mostly server-side.

### ~~C1 — Departing a stop with a checked-in student is unguarded~~ · Closed 12 Aug

### ~~C2 — Nothing on the server watches the clock~~ · Closed 12 Aug

All escalation is driven by a driver tap. If the phone dies, is pocketed, or the
driver simply stops tapping, the trip stays `active` indefinitely and **nobody is
told**. The coordinator's exception queue is pull-based and its `missing` list
excludes `scheduled` riders
([app/(staff)/exceptions.tsx](../app/%28staff%29/exceptions.tsx)) — so a child the van
has already passed without touching is invisible there too.

**Approach — one cron function, five queries.**

```
transport_watchdog() returns jsonb
```

Alerts on: trip not started N minutes past the first stop's `planned_departure`;
stop not arrived N minutes past its `planned_arrival`; a rider `waiting` longer
than N minutes; a trip `active` past a plausible maximum; a rider still
`in_transit` after the van departed its last stop.

Needs a `watchdog_alerts (trip_id, stop_id, kind, raised_at)` table so a breach
alerts **once**, not every five minutes. Thresholds belong on `organization`
alongside the cutoffs, not hard-coded. Schedule with pg_cron every 5 minutes
during operating hours only.

**Effort:** ~1 day including thresholds and the settings UI.
**Risk:** low, and it is the highest-return single item in this document — it
converts every silent failure in the system into an alert, including ones not
enumerated here.

---

## Phase 2 — correction paths

**Why second:** this is a phone held one-handed in a moving vehicle by someone
also responsible for children. Mistaps are not an edge case, and right now most of
them require a phone call to the office.

### ~~C4 — A student marked absent who turns up cannot be boarded~~ · Closed 12 Aug

Built for `no_show` as well as `absent` and `parent_pickup` — a child who ran up
two minutes late is the most common instance of it, and the undo in C5 only
covers 90 seconds. `AWAY_STATUSES` in `src/lib/types.ts` is the list.

### ~~C5 — No undo, and no correction path for stop progress below admin~~ · Closed 12 Aug

Two holes, one shape.

*Rider status:* a mistapped `no_show` is terminal — the card renders with no
actions.

*Stop progress:* once `departed_at` is written the arrive button is gone and the
next stop unlocks. And **staff can only read that table** — the policy is `for
select` ([supabase/schema.sql](../supabase/schema.sql)) while writes require
`drives_trip`. **A coordinator cannot fix a mistapped departure at all.** The only
tool is `rerun_trip`, which is admin-only and wipes the whole trip.

**Approach.**

1. One-line RLS change: staff policy on `trip_stop_progress` becomes `for all`.
2. A 90-second undo on the last rider action and the last stop action. Reuse
   `audit_logs` — the previous status is already recorded in `old_value`, so undo
   reads the last entry for that row inside the window and reverts to it, writing a
   *compensating* entry rather than a silent revert.

**Effort:** ~half a day. **Risk:** low. The audit-log reuse is what keeps it honest.

### ~~C8 — Transitions are unguarded; only the writer is checked~~ · Closed 12 Aug

RLS checks *who* may write *which* status, never *what may follow what*. A raw call
with a driver's token can move a rider `scheduled → dropped_off`, never boarded,
and every downstream consumer accepts it. The UI is the only thing preventing it —
which contradicts the README's claim that these are database rules.

**Approach.** A `before update` trigger holding the transition table from the
review (reproduced in [FEATURES.md](FEATURES.md)). Everything not in the table is
refused. Staff override stays exempt, with its existing mandatory reason.

**Effort:** ~3 hours. **Risk:** low, but write it *after* C4, so the new
away → boarded transition is in the table from the start.

---

## Phase 3 — connectivity

### C3 — No offline queue  · Safety · **STILL OPEN — the only one**

Every driver action is a direct PostgREST write; a failure surfaces as a red
string under a card. No retry, no queue, no local write-ahead log — `expo-sqlite`
is in the bundle but only holds the auth session.

The realistic failure is not that the driver stops. It is that they keep driving:
ten minutes of dead zone is three stops with no boarding record, reconstructed
afterwards from somebody's memory.

**Approach.** A SQLite outbox.

1. `outbox(id, table, op, payload, client_ts, attempts, created_at)`.
2. Driver mutations enqueue and return optimistically; a flush runs on reconnect
   and on app foreground.
3. **Server takes the client's timestamp, not `now()`.** Mostly already true —
   `board_time`, `dropoff_time`, `arrived_at`, `departed_at` and `updated_at` are
   all client-supplied today. Audit and notification triggers need to respect it
   too, or a queued boarding will be logged at flush time.
4. An unmistakable **“3 actions not yet saved”** banner. Silence here is the bug.

Only the driver app needs this. Parents and students can retry by pulling to
refresh; a driver cannot re-drive the route.

**Effort:** 2–3 days, and the only item here that is genuinely a project.
**Risk:** medium — ordering and idempotency need care. Every write is already
keyed by row id, which helps.

---

## Phase 4 — telling people things

### ~~C6 — Arrival alerts are local-only, and fail totally and silently~~ · Closed 12 Aug

[src/lib/alerts.ts](../src/lib/alerts.ts) schedules on-device notifications. Four
consequences, none observable by anyone:

- **They only exist if the app was opened that day.** Acknowledged in the file as
  a trade; for the primary *“walk to the hub now”* signal it is not one to take.
- **Web gets nothing** — `Platform.OS !== 'web'` short-circuits the module, and
  web is a supported parent target.
- **The scheduling effect re-runs on every render.** `rows`/`mine` are fresh array
  identities each pass, so each render calls
  `cancelAllScheduledNotificationsAsync()` and rebuilds. There is a window on every
  render with zero alerts armed, and the cancel is global.
- **Away students still get alerted** — arrivals are not filtered by status.

**Approach.** Move them onto the path everything else already uses: a cron pass
over today's stops inserting `notifications` rows at planned-minus-15 and
planned-minus-5. That buys push, the in-app inbox, web, and a queryable delivery
record. Delete the local path.

This is **not** waiting for GPS. It is a delivery-channel fix, and it makes the
later GPS upgrade a change to one query. The live `VanEta` added on 10 August
already covers the *accurate* case and is worded differently on purpose — “6
minutes away” versus “due in 15 minutes”.

**Effort:** ~1 day. **Risk:** low.

### ~~S1 — No structured delay, so a late van's alerts stay confidently wrong~~ · Closed 12 Aug

`daily_trips.delay_minutes` and `delay_reason` exist and nothing writes them. The
driver's only delay path is a free-text incident, which notifies parents but shifts
nothing.

**Approach.** “Running late” with a quick +10/+15/+30. Writes `delay_minutes`,
shifts the remaining planned times for the day, reschedules the C6 alerts, updates
every parent's expected time. **Do this in the same pass as C6** — they touch the
same query.

**Effort:** ~half a day on top of C6.

### ~~S6 — Push has no delivery guarantee and no escalation~~ · Closed 12 Aug (SMS fallback still needs a provider)

`send-push` returns early when a profile has no token
([supabase/functions/send-push](../supabase/functions/send-push/index.ts)). No
record, no retry, no fallback. The in-app inbox is the backstop and needs the app
opened. For `URGENT — could not drop off`, that is not a delivery mechanism.

**Approach.** Record attempt and outcome per notification. For the two urgent
kinds, require acknowledgment and escalate to SMS or a call after a few
unacknowledged minutes.

**Effort:** ~1 day, plus whatever the SMS provider decision costs.

### ~~S7 — No notification when the van reaches or leaves a stop~~ · Closed 12 Aug

`trip_stop_progress` writes are silent, and `in_transit` has no notification at all
despite appearing in the parent timeline. The parent's most-asked question — *has it
been past yet?* — is answerable only by opening the app.

**Approach.** Notify a rider's guardians on departure from their own hub. That is
the moment the answer changes.

**Effort:** ~2 hours.

---

## Phase 5 — the rest

| | Problem | Approach | Effort |
| --- | --- | --- | --- |
| ~~**C7**~~ | Wrong stop still unboardable; wrong vehicle undetectable in **manual** mode. Scan mode is covered. | “Boarded at a different stop” recording the actual stop. A driver-initiated “this student isn't on my list” lookup across today's trips, alerting the coordinator and letting staff move a rider between trips. Needs a widened RLS read for active same-org trips. | ~1 day |
| ~~**S2**~~ | `no_show` after a check-in files identically to one from nothing — the first means the child said they were there and then were not picked up. | Keep one status; branch escalation on `check_in_time` being set. Route the checked-in case to the coordinator with acknowledgment. | 3 h |
| ~~**S4**~~ | Cutoff is a wall clock, not a trip boundary. Between cutoff and departure an absence sits `pending`; if nobody is watching, the driver waits for a child who was never coming, then files a no-show that alarms everyone. | Auto-approve `absent` any time before that student's trip starts; hard-freeze at trip start; keep the queue for mid-route changes. An unnecessary absence costs a stop; a missed one costs a false alarm. | 4 h |
| ~~**S5**~~ | Roster generation adds but never removes — `on conflict do nothing` means a student taken off a route stays on today's trip, blocking completion. | Delete `scheduled` rows with no matching assignment, mirroring the club-cancellation branch that already does this. | 2 h |
| ~~**S8**~~ | `ensure_daily_trips` is `security definer` granted to every authenticated user — any student can materialise trip rows for an arbitrary date. | Restrict to staff, run from cron, give clients a narrow today-only wrapper. | 2 h |
| ~~**S9**~~ | *Closed 12 Aug, folded into C1 as planned.* | | |
| ~~**N1**~~ | Two children at the same hub get two near-identical alerts. | Collapse when hub and time match. | 1 h |
| ~~**N2**~~ | `checkin_window_min` exists with no check behind it — a student can check in at 3am. | Enforce in the student RLS policy, not the client. | 2 h |
| ~~**N3**~~ | No audit-log viewer. Entries are written faithfully; nothing displays them. | A staff screen. The first time this matters will be a dispute — the worst moment to be writing SQL by hand. | 4 h |
| ~~**N4**~~ | Cutoff times are SQL-only. | Surface in Setup. Do **after** S4, which changes their meaning. | 2 h |
| ~~**N5**~~ | Announcements are not route- or child-targeted. | Fine at three vans, not at thirty. | 4 h |

---

## Sequencing, in one line each

1. ~~**C4** first — two hours, removes the worst active-harm path.~~ *Done 12 Aug.*
2. ~~**C1 + S9** together — same table.~~ *Done 12 Aug.*
3. ~~**C2** — the watchdog. Everything after this fails loudly instead of silently.~~ *Done 12 Aug.*
4. ~~**C5**, then **C8** — correction paths, then lock the transition table around them.~~ *Done 12 Aug.*
5. ~~**C6 + S1 + S7** — one pass over the notification path.~~ *Done 12 Aug.*
6. **C3** — the offline queue, once the safety work is not waiting on it. **← the only one left.**
7. ~~**S2, S4, S5, S8**, then **C7** manual mode.~~ *Done 12 Aug.*
8. ~~**N1–N5** as capacity allows. **N4** after **S4**.~~ *Done 12 Aug, N4 after S4 as instructed.*

## Checklist — everything this plan asked for

As of **12 August 2026**. Twenty-one of the twenty-two are done; **C3 is the one
that is not**, and it is deliberately last for the reason the plan itself gives.

**Phase 1 — the silent failures**

- [x] **C1** Departing a stop with a checked-in student · *Safety* — two-phase departure, `guard_stop_departure()`, override files an incident per child
- [x] **C2** Nothing on the server watches the clock · *Safety* — `transport_watchdog()`, six checks, alerts once, clears itself, thresholds in Setup

**Phase 2 — correction paths**

- [x] **C4** Absent student who turns up cannot be boarded · *Safety* — “Boarding anyway”, note required by the database
- [x] **C5** No undo, no correction path for stop progress · *Safety* — `undo_rider_status()`, `undo_stop_progress()`, staff RLS on `trip_stop_progress` widened to `for all`
- [x] **C8** Transitions unguarded — `guard_rider_transition()` holds the table; anything not in it is refused

**Phase 3 — connectivity**

- [ ] **C3** No offline queue · *Safety* — **not done.** The only item here that is genuinely a project (2–3 days), and the only one whose risk is *shipping it badly*: a half-built sync layer that drops or reorders writes is worse than no sync layer at all in an app about where children are. Everything else is now in place, so it is no longer blocking any safety work. See the note below.

**Phase 4 — telling people things**

- [x] **C6** Arrival alerts local-only and silently failing · *Safety* — `send_arrival_alerts()` on the notification path; `src/lib/alerts.ts` deleted
- [x] **S1** No structured delay — `report_delay()`, cumulative, shifts every remaining time and re-fires the alerts
- [x] **S6** Push has no delivery guarantee — delivery state recorded per notification; urgent kinds require acknowledgement and escalate to the watchdog. *SMS fallback still needs a provider decision.*
- [x] **S7** No notification when the van reaches or leaves a stop — guardians told on departure from their own hub

**Phase 5 — the rest**

- [x] **C7** Wrong stop unboardable; wrong vehicle undetectable in manual mode — `find_rider_today()`, `board_at_other_stop()`, `move_rider_to_trip()`
- [x] **S2** `no_show` after a check-in files identically — distinct escalation, its own section in the exception queue
- [x] **S4** Cutoff is a wall clock, not a trip boundary — auto-approve until the van actually starts, hard-freeze after
- [x] **S5** Roster generation adds but never removes — `scheduled` rows with no assignment are deleted
- [x] **S8** `ensure_daily_trips` callable by any authenticated user — revoked; `ensure_todays_trips()` is the narrow client wrapper
- [x] **S9** Stop progress has no integrity constraints — ordering check, explicit `skipped`, arrival not overwritable by the driver
- [x] **N1** Two children at one hub, two near-identical alerts — collapsed, for arrival alerts and departure alerts
- [x] **N2** `checkin_window_min` with no check behind it — enforced in the student RLS policy
- [x] **N3** No audit-log viewer — the History tab
- [x] **N4** Cutoff times SQL-only — Setup → Features, done after S4 as instructed
- [x] **N5** Announcements not route- or child-targeted — targeting moved into a trigger; the client no longer fans out to everybody

**Found while doing the above, and fixed**

- [x] `notify_on_incident()` broadcast every incident's description to every guardian on the route — with C1 filing per-child incidents that would have named the left-behind child to every other family
- [x] `schema.sql` could not be re-run — `trip_stop_progress` and `assignment_requests` were missing from the drop list
- [x] `select coalesce(…) into` left variables NULL when no row matched, nulling whole notification bodies
- [x] The watchdog would have false-alarmed on **every afternoon run** — the school is the origin the driver never marks arrival at

### On C3

The plan's own sequencing puts the offline queue last, "once the safety work is
not waiting on it". That is now true: every other item is closed, and the
watchdog means a driver who goes silent in a dead zone is *noticed* even with no
queue at all — which was the part that actually mattered.

What is left is the work itself, and it is not the kind to rush: an outbox needs
ordering, idempotency and conflict rules that are correct on the first day,
because the failure mode is a boarding record that arrives in the wrong order or
not at all. The plan budgets 2–3 days and calls the risk *medium*. It should get
that, not an afternoon.

It also has a live dependency in **Still unanswered** below: *cell coverage
across the whole route* decides whether C3 is a safeguard or load-bearing, and
that changes how much of it is worth building.

## Still unanswered

These change the design, and no amount of code decides them:

- **Is the coordinator watching a screen during the run?** The whole exception
  design assumes an attended dashboard. If the answer is “sometimes”, C2 stops
  being a should-have and becomes the only safety net that exists.
- **Must a guardian be present at afternoon drop-off, and does the driver verify?**
  This alone decides whether `dropped_off` is one tap or a two-party confirmation.
- **What ages?** A reception child and a sixth-former imply different drop-off
  rules and different no-show urgency. Nothing in the model carries age.
- **Cell coverage across the whole route?** Decides whether C3 is a safeguard or
  load-bearing.
- **Company phones or personal?** Battery is now a safety dependency.
- **Jurisdiction's record-keeping requirement for child transport custody?** May
  already dictate the drop-off answer, the retention policy, and how much of the
  weekly purge is legal.
- **Is three vans the business, or the first customer?** Single-tenant with no
  `companyId` is the expensive thing to change later.
