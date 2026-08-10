# Remediation plan

A design review on 10 August 2026 stress-tested the morning and afternoon ride
flow against this codebase and found **22 problems**, graded by consequence rather
than effort. This is the plan to close them.

Two things to know before reading:

- **The flow document the review was given was behind the code.** Three of its
  open questions were already settled here — per-stop drop-off, student check-in
  being firewalled from boarding, and empty-stop skipping. Those are not in this
  plan because they are not problems.
- **Four items are already closed**, by the 10 August session. They are listed
  first so nobody re-does them.

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

## Phase 1 — the silent failures

**Why first:** these are the only two items where a child can end up unaccounted
for and *no human is told at all*. Everything else in this plan is worse data or a
harder job. These two are worse outcomes. Both are small, and mostly server-side.

### C1 — Departing a stop with a checked-in student is unguarded  · Safety

`markDeparted` promotes only `boarded` riders to `in_transit`
([app/(driver)/trip/[id].tsx](../app/%28driver%29/trip/%5Bid%5D.tsx)). A student who
tapped *“I'm at the hub”* and was never boarded stays `waiting` while the van pulls
away. Nothing fires. The catch is at **End trip** — potentially forty minutes and
eight stops later.

Worse than the child who never checked in, because the app *knew* they were there.

**Approach — two-phase departure.** Add a `CLEARING` step between arrived and
departed:

1. `trip_stop_progress` gains `departed_with_unresolved boolean not null default false`.
2. New `before insert or update` trigger `guard_stop_departure()`. When
   `departed_at` is being set, count riders assigned to that stop whose status is
   not terminal-for-this-stop. If any, and the override flag is false → `raise`.
3. Override is allowed — a driver must always be able to keep driving — but costs
   an `incidents` row and immediate notifications to the affected guardians and
   the coordinator. Not silence.
4. Driver UI: pre-check before the write and offer the outcome inline
   (*Boarded / No-show / Absent*) rather than sending them back up the screen.

**Effort:** ~half a day. **Risk:** low; additive trigger, existing notification path.

### C2 — Nothing on the server watches the clock  · Safety

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

### C4 — A student marked absent who turns up cannot be boarded  · Safety

`isFinal('absent')` is true, so `showBoarding` is false and the driver sees **no
buttons** for a child standing in front of them. Same for `parent_pickup`. The only
route out is a coordinator override, mid-route, from a desk.

What actually happens: the driver takes the child, because of course they do, and
the record says absent. A child on a van that officially is not carrying them —
the exact state this app exists to prevent.

**Approach.** The RLS policy already permits a driver to write `boarded`; only the
UI blocks it. Add **“Boarding anyway — turned up”** on any away status. Force a
note, notify guardians and coordinator. Same shape as `unable_to_drop_off`: an
exception that must be *recordable*, not one that must be prevented.

**Effort:** ~2 hours. **Risk:** very low. Do this one first in the phase.

### C5 — No undo, and no correction path for stop progress below admin  · Safety

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

### C8 — Transitions are unguarded; only the writer is checked

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

### C3 — No offline queue  · Safety

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

### C6 — Arrival alerts are local-only, and fail totally and silently  · Safety

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

### S1 — No structured delay, so a late van's alerts stay confidently wrong

`daily_trips.delay_minutes` and `delay_reason` exist and nothing writes them. The
driver's only delay path is a free-text incident, which notifies parents but shifts
nothing.

**Approach.** “Running late” with a quick +10/+15/+30. Writes `delay_minutes`,
shifts the remaining planned times for the day, reschedules the C6 alerts, updates
every parent's expected time. **Do this in the same pass as C6** — they touch the
same query.

**Effort:** ~half a day on top of C6.

### S6 — Push has no delivery guarantee and no escalation

`send-push` returns early when a profile has no token
([supabase/functions/send-push](../supabase/functions/send-push/index.ts)). No
record, no retry, no fallback. The in-app inbox is the backstop and needs the app
opened. For `URGENT — could not drop off`, that is not a delivery mechanism.

**Approach.** Record attempt and outcome per notification. For the two urgent
kinds, require acknowledgment and escalate to SMS or a call after a few
unacknowledged minutes.

**Effort:** ~1 day, plus whatever the SMS provider decision costs.

### S7 — No notification when the van reaches or leaves a stop

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
| **C7** | Wrong stop still unboardable; wrong vehicle undetectable in **manual** mode. Scan mode is covered. | “Boarded at a different stop” recording the actual stop. A driver-initiated “this student isn't on my list” lookup across today's trips, alerting the coordinator and letting staff move a rider between trips. Needs a widened RLS read for active same-org trips. | ~1 day |
| **S2** | `no_show` after a check-in files identically to one from nothing — the first means the child said they were there and then were not picked up. | Keep one status; branch escalation on `check_in_time` being set. Route the checked-in case to the coordinator with acknowledgment. | 3 h |
| **S4** | Cutoff is a wall clock, not a trip boundary. Between cutoff and departure an absence sits `pending`; if nobody is watching, the driver waits for a child who was never coming, then files a no-show that alarms everyone. | Auto-approve `absent` any time before that student's trip starts; hard-freeze at trip start; keep the queue for mid-route changes. An unnecessary absence costs a stop; a missed one costs a false alarm. | 4 h |
| **S5** | Roster generation adds but never removes — `on conflict do nothing` means a student taken off a route stays on today's trip, blocking completion. | Delete `scheduled` rows with no matching assignment, mirroring the club-cancellation branch that already does this. | 2 h |
| **S8** | `ensure_daily_trips` is `security definer` granted to every authenticated user — any student can materialise trip rows for an arbitrary date. | Restrict to staff, run from cron, give clients a narrow today-only wrapper. | 2 h |
| **S9** | Stop progress has no integrity constraints: nothing enforces `departed_at >= arrived_at`, a re-tapped arrival overwrites the original time, and skipped-vs-served is inferred from a null. | A `check` on ordering, and an explicit `skipped` boolean. Fold into C1, which already touches this table. | 1 h |
| **N1** | Two children at the same hub get two near-identical alerts. | Collapse when hub and time match. | 1 h |
| **N2** | `checkin_window_min` exists with no check behind it — a student can check in at 3am. | Enforce in the student RLS policy, not the client. | 2 h |
| **N3** | No audit-log viewer. Entries are written faithfully; nothing displays them. | A staff screen. The first time this matters will be a dispute — the worst moment to be writing SQL by hand. | 4 h |
| **N4** | Cutoff times are SQL-only. | Surface in Setup. Do **after** S4, which changes their meaning. | 2 h |
| **N5** | Announcements are not route- or child-targeted. | Fine at three vans, not at thirty. | 4 h |

---

## Sequencing, in one line each

1. **C4** first — two hours, removes the worst active-harm path.
2. **C1 + S9** together — same table.
3. **C2** — the watchdog. Everything after this fails loudly instead of silently.
4. **C5**, then **C8** — correction paths, then lock the transition table around them.
5. **C6 + S1 + S7** — one pass over the notification path.
6. **C3** — the offline queue, once the safety work is not waiting on it.
7. **S2, S4, S5, S8**, then **C7** manual mode.
8. **N1–N5** as capacity allows. **N4** after **S4**.

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
