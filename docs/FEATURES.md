# What is built, and how it compares to the blueprint

A feature-by-feature account of the app as it stands, checked against the
**Student Transportation Platform — MVP Functional Blueprint (Review Draft)**.

Written to be read by someone who has the blueprint in front of them and wants to
know: *did they build what we asked for, and where did they not?*

**Last updated 10 August 2026.** Two companion documents:
[CHANGELOG](../CHANGELOG.md) for what changed when, and
[REMEDIATION](REMEDIATION.md) for problems a flow review found that the blueprint
never raised — including four where a child can go unaccounted for and nobody is
alerted. This document answers "does it match the brief"; that one answers "is the
brief enough".

Three symbols throughout:

| | |
| --- | --- |
| ✅ | Built as the blueprint describes |
| ⚠️ | Built, but **differs** from the blueprint — read the note |
| ⛔ | **Not built**, deliberately |

---

## The short version

**Built and working:** all six blueprint roles' screens, hub-based routing, route
templates that generate daily trips, the full nine-state student status model,
driver-confirmed boarding, the end-of-trip checklist, the change-request cutoff
workflow, the coordinator exception queue, notifications, and the audit log.

**The eight acceptance scenarios in §9.1** are all supported. Six are verified
against a real database; two (driver substitution, club route) are supported but
have not been driven end-to-end with real accounts yet.

**Five deliberate divergences**, each with a reason:

1. **Supabase instead of Firebase** (§7) — the blueprint says "may use".
2. **One organisation, no `companyId`** (§1) — one transport operation, three vans.
3. **Invite-based signup** rather than the admin inventing a password on the
   user's behalf (§6.1) — same control, same outcome, no password to transmit.
4. **iOS + Android + web**, not web-only (§7.3).
5. **No Platform Super Admin** (§2) — pointless with one company.

**Runs on all three platforms** from one codebase: `npx expo run:ios`,
`npx expo run:android`, `npm run web`. The web build is what lets a coordinator
work at a desk, which is what §7.3 was really asking for.

**Two features are built but switched off**, because the blueprint excludes them:
live GPS and payments. "Switched off" here means a flag, not a stub — as of
10 August 2026 turning `gps_enabled` on puts the van on the parent and student
maps with a live ETA, no new build required. It reports **only while a route is
running**, and a stationary van reports on movement rather than continuously,
which is what makes §8's cost-and-battery objection answerable rather than
ignored.

**QR boarding is built** (`attendance_mode = 'scan'`), on both legs of the day.
The **driver scans the student**, never the reverse — a code the student scanned
themselves would be a self-reported boarding, which §2.1 forbids. NFC is not
built; QR does the same job on every phone with no extra hardware.

**Absences cover a date range.** A month's holiday is one request, not twenty.

**A watchdog watches the clock.** Every other escalation here waits for a driver
to tap something; if the phone dies or is pocketed, nothing used to happen at all.
`transport_watchdog()` runs every five minutes during operating hours and raises a
route that never started, a van overdue at a stop, a child still waiting at a hub,
a trip that never ended, a child still aboard after the last stop, and an urgent
message nobody has acknowledged — each **once**, clearing itself when the
condition goes away.

**Twenty-one of the twenty-two findings** from the 10 August design review are
closed as of 12 August. The exception is the offline queue — see
[the remediation plan](REMEDIATION.md).

**One thing the blueprint did not ask for:** a weekly archive and purge. Every
Sunday each student's week is rolled into a single report and sent to their
family, and only then is the routine detail behind it deleted — so the database
stops growing without bound, while incidents, no-shows and coordinator overrides
are kept forever. An administrator turns it on with a switch. See
[the weekly report and purge](#beyond-the-blueprint-the-weekly-report-and-purge).

---

## 1. Scope and MVP boundaries

### 1.1 Included in the first version

| Blueprint asks for | Status | Notes |
| --- | --- | --- |
| User sign-in and role-based pages | ✅ | Each role gets its own route group. A role's screens are not merely hidden from others — they are not registered, so they cannot be reached by deep link. |
| One pilot company, configurable name and logo | ⚠️ | `organization` table holds the name and logo, but there is **one** row rather than a `companies` table. See §7.1 below. |
| Student, parent, driver, coordinator, company-admin records | ✅ | All five. Platform Super Admin omitted — see §2. |
| Neighbourhood hubs and school locations | ✅ | `hubs` and `schools`. Hubs are reusable across routes. |
| Separate Morning / Afternoon / Club routes | ✅ | Plus `emergency`, per §3.2. |
| Daily trip creation from a route template | ✅ | `ensure_daily_trips()`. Idempotent. Runs when anyone opens the app, and optionally on a nightly `pg_cron` schedule. |
| Student check-in, driver boarding confirmation, driver drop-off confirmation | ✅ | And the distinction between them is enforced in the database — see the box below. |
| Parent absence, parent-pickup, club-status updates | ✅ | With the cutoff rule from §4.2. Surfaced as **"Report absence"** — see the naming note in §4.2 below. |
| Coordinator dashboard showing current trip and student statuses | ✅ | Summary cards, trip board, exception queue. |
| Simple in-app or push notifications | ✅ | In-app everywhere; push on iOS/Android with an EAS project. |
| Daily trip history and a basic exportable report | ⚠️ | History is built for every role, and every family now receives a **weekly report** of their student's rides (see "the weekly report and purge" below). Still **no downloadable file** — nothing writes a CSV. |

> ### The rule the whole app is shaped around
>
> §2.1: *"Student-submitted check-in means 'I am waiting'; it does not prove the
> student boarded."*
>
> The student's button says **"Check in — I'm at the hub"** and sets status
> `waiting`. It cannot set `boarded`. Not "the UI does not offer it" — the
> database refuses it:
>
> ```sql
> create policy "students check in only" on student_trip_status for update
>   using (student_id = auth.uid())
>   with check (student_id = auth.uid() and status = 'waiting');
> ```
>
> This was tested by attacking it: signing in as a student and issuing the UPDATE
> directly against the database, with no app involved. It is refused. A parent
> cannot do it either. Only the assigned driver — or a coordinator, who must give
> a reason that lands in the audit log.
>
> It matters because the failure is silent: a child taps "I boarded", misses the
> van, and the school believes they are safely aboard. Nobody goes looking.

### 1.2 Explicitly excluded — and correctly absent

| Blueprint excludes | Status |
| --- | --- |
| Automatic route optimisation or AI | ⛔ Not built |
| Turn-by-turn navigation in the app | ⛔ Not built. The driver hands off to the phone's own maps app. |
| Payments, subscriptions, invoicing, payroll | ⛔ **Built but switched off** — see "Switched-off features" |
| School information-system integration | ⛔ Not built |
| Vehicle-to-vehicle transfers at hubs | ⛔ Not built. A student stays in one vehicle, per §3.1.5. |
| Facial recognition, biometrics, continuous background location | ⛔ No biometrics anywhere. GPS is **built and switched off** — and when switched on it is still not *continuous*: collection is scoped to a running route by four independent guards, and a stationary van goes quiet. See [Live GPS](#live-gps--gps_enabled--false). |
| Advanced emergency dispatch / 911 | ⛔ Not built. Incidents go to the coordinator. |
| Public App Store launch before pilot and privacy review | ⛔ Not submitted anywhere |

### 1.3 Success criteria

| Measure | Where it stands |
| --- | --- |
| Driver completes a route without a paper roster | ✅ The stop roster is grouped by hub, with per-student actions. |
| Parent sees boarding and safe drop-off for linked children | ✅ Live, with a timeline and push. |
| **Every student ends with a final status** | ✅ **Enforced.** The database refuses to close a trip otherwise. |
| Absence, parent pickup, no-show, delay, club change can all be recorded | ✅ All five. |
| Demonstrable with realistic sample data | ✅ `seed.sql` gives one school, three vans, four hubs, three routes. |

---

## 2. Roles and access

| Blueprint role | Status |
| --- | --- |
| Platform Super Admin | ⛔ **Omitted.** The blueprint itself says "not used frequently during pilot", and it manages *other companies* — of which there are none. |
| Company Administrator | ✅ `admin` |
| Transportation Coordinator | ✅ `coordinator` — runs the day, but cannot invite people or change settings |
| Driver | ✅ |
| Parent | ✅ |
| Student | ✅ |

### 2.1 Security rules — all six enforced in Postgres, not in the UI

| Rule | How |
| --- | --- |
| Every record carries a company ID | ⚠️ **Not applicable** — one organisation. See §7.1. |
| Parents never see unrelated students | ✅ RLS: a parent sees only *accepted* guardian links |
| Drivers never see unassigned routes | ✅ RLS: `daily_trips` where `driver_id = auth.uid()` |
| Only staff may override a status, and a reason is required | ✅ RLS + the app demands a reason, which the audit trigger records |
| Driver confirmation is the official record | ✅ See the box above |
| Student check-in ≠ boarding | ✅ See the box above |
| Minimum necessary information | ✅ A student sees the driver's **first name only**; a driver sees no parent contact details unless there is an exception |

Every one of these was verified by attacking the database directly, as each role,
with the app out of the loop entirely:

| Attempt (raw SQL, signed in as that person) | Result |
| --- | --- |
| Student marks **themselves boarded** | **Refused** |
| Student marks themselves dropped off | **Refused** |
| Student checks in → `waiting` | Allowed |
| **Parent** marks their own child boarded | **Refused** |
| The assigned **driver** marks them boarded | Allowed |
| Student reads another student's trip row | Sees only their own |
| Student sets their own role to `admin` | **Refused** |
| Student issues themselves an invite | **Refused**, and the table is invisible to them |
| Driver ends a trip with a student unresolved | **Refused** |
| **Suspended** account reads any trip or route | **0 rows** |

> The suspended case was a **real bug**, found this way. Policies keyed on
> `student_id = auth.uid()` never checked whether the account was still active —
> so suspending someone only hid the screens, while their session kept working
> against the API. Every data policy is now gated on `is_active()`. Suspension
> has to bite at the database or it is theatre.

### 2.2 The nine statuses

All present, exactly as named: Scheduled, Waiting, Boarded, In Transit, Dropped
Off, Completed, Absent, Parent Pickup, No-Show — **plus** `unable_to_drop_off`,
which §6.3 requires but §2.2 does not list as a status. It had to become one,
because it blocks the trip from closing.

---

## 3. Routing model

| Blueprint | Status |
| --- | --- |
| Reusable route templates | ✅ `route_templates` |
| Daily trips generated from templates | ✅ `ensure_daily_trips()` |
| Hubs created by the administrator | ✅ Setup → Hubs |
| Each student has a default morning and afternoon hub | ✅ Set by staff on the People tab |
| A route is an ordered list of hubs and school stops | ✅ `route_stops`, with exactly one of `hub_id`/`school_id` |
| Parents see the assigned hub and expected time | ✅ |
| Drivers see the ordered stop list and who is at each hub | ✅ |
| A student stays in one vehicle for the whole trip | ✅ No transfers |
| Morning / Afternoon / Club behave differently | ✅ Club seats **only** students approved as attending |
| Capacity warning when the roster exceeds the vehicle | ✅ Shown to both driver and coordinator |
| Emergency / substitute route | ⚠️ The route *type* exists and a coordinator can reassign a driver or vehicle before a trip starts. There is no dedicated "create an emergency route" flow. |

---

## 4. Student and parent screens

### 4.1 Student

| Screen | Status |
| --- | --- |
| **Today** — route type, hub, planned time, driver first name, vehicle, status, Check In | ✅ |
| **Club Status** — attending / cancelled / not attending / parent pickup, with approval state and cutoff | ✅ |
| **History** — date, route type, boarded time, drop-off time, final status | ✅ |
| **Profile** — name, school, grade, guardians, default hubs, **read-only** | ✅ Read-only, as specified. The student does not choose their own hub. |

| Rule | Status |
| --- | --- |
| Check In only on the travel day | ✅ Only today's trip rows exist to check into |
| Check In within a configurable window | ⚠️ `checkin_window_min` exists in the database (default 60) but **is not yet enforced** — a student can currently check in any time on the day of travel. Honest gap. |
| Club change stays Pending until approved | ✅ |
| Student cannot mark Boarded or Dropped Off | ✅ Enforced in the database |
| "No transportation scheduled today" when there is none | ✅ Those exact words |

### 4.2 Parent

| Screen | Status |
| --- | --- |
| **My Children** — a card per child, current status, next expected event | ✅ |
| **Child Trip** — the timeline | ⚠️ Built. The blueprint's timeline includes **"Approaching"**, which is still not a *timeline step* — but since 10 Aug, with GPS on, the card carries a live **"6 minutes away"** derived from the van's actual position, which is the information that step was for. The other six steps are all there. |
| **Report a change** — absence, parent pickup, club attending/not attending | ✅ | The blueprint calls this "Parent absence". Renamed in the UI — see below. |
| **Notifications** | ✅ |
| **History** | ✅ |

| Rule | Status |
| --- | --- |
| A parent can only update linked children | ✅ RLS |
| Before the cutoff → applies automatically | ✅ Decided by a database trigger, not the client |
| After the cutoff → Pending, coordinator approves | ✅ |
| Permanent hub/address changes are **not** self-service | ✅ The screen says to ask the office |
| Vehicle location only if GPS is enabled | ✅ With it on: live position and ETA per child, and the van on the route map. With it off: a panel explains why. |
| Absence can cover several days | ✅ Beyond the blueprint. `end_date` on the request; only the first day is judged against the cutoff, so a holiday booked ahead is always in time. |

> ### One rename: "Parent absence" → "Report absence"
>
> The blueprint calls this **"Parent absence"** (§1.1), and the first build put a
> button labelled **"Absent"** on the parent's screen. That conflates two things:
>
> - **What the parent DOES** — reports an absence.
> - **What the child BECOMES** — `Absent`.
>
> A button named after the outcome reads like a toggle on the student, rather
> than a message to the school. So the actions are now named as actions —
> **"Report absence"**, **"Report parent pickup"** — and each states its outcome
> underneath it (*"Sahasra will show as Absent"*), so nobody presses a button
> without knowing what it will cause. The **status** is still `Absent`; only the
> **action** was renamed.
>
> Same reasoning for the tab: **Daily change → Report**.

> ### The morning workflow, verified end to end
>
> Run against a real Postgres, not asserted:
>
> | Step | Result |
> | --- | --- |
> | 6:30 — parent reports absence (before cutoff) | Auto-approved. Driver's roster **already shows Absent** before the van leaves. |
> | Driver's roster at the hub | Mike `absent` → **stop is skippable**; the app says so |
> | 7:05 — student taps **Check In** | → `Waiting`. Driver **and** coordinator notified. |
> | Student tries to claim **Boarded** | **Refused by the database.** Status stays `Waiting`. |
> | 7:12 — driver taps **Boarded** | → `Boarded`. **Parent notified**: "Sahasra boarded the vehicle." |
> | Student never appears | Driver marks `No-Show` → **parent and coordinator notified** |
> | Driver ends trip with a student still aboard | **Refused**: *"Cannot end the trip: 1 student(s) still have no final status."* Trip stays `active`. |
> | Driver drops her off, then ends the trip | Trip `completed`; riders resolved |
>
> **Waiting vs No-Show** are deliberately different facts: *"I am here"* (the
> student's claim) versus *"I came, they weren't"* (the driver's record). Neither
> can be set by the other party.

---

## 5. Driver and coordinator

### 5.1 Driver

| Screen | Status |
| --- | --- |
| **Today's Trips** — start time, vehicle, status | ✅ |
| **Trip Overview** — ordered stops, student count, capacity, planned times, Start Trip, Report Delay | ✅ |
| **Stop Roster** — students at each stop with name, status, actions | ⚠️ No **photo or initials**. The blueprint asks for a photo; storing children's photographs is a privacy decision that should not be made by a developer on a whim, so it is left out pending your call. |
| **Student Action** — Boarded, Absent, No-Show, Parent Pickup, Dropped Off Safely, Unable to Drop Off | ✅ All six |
| **Incident** — type, affected student/vehicle, description, severity | ⚠️ All of that, **except the optional photo** |
| **End Trip** — checklist confirming every student has a final status | ✅ **Enforced by the database**, not just checked in the UI |

| Rule | Status |
| --- | --- |
| Large, simple buttons; discourage interaction while moving | ✅ Large touch targets; the driver gets a stack, not tabs, so there is nothing to browse |
| Cannot complete a trip with an unresolved student | ✅ *"Cannot end the trip: 2 student(s) still have no final status."* |
| Unable to Drop Off creates an urgent coordinator exception | ✅ And blocks trip closure until a coordinator resolves it |
| Corrections after confirmation are staff-only, with an audit reason | ✅ |
| Driver sees minimum parent contact information | ✅ None, unless there is an exception |

### 5.2 Coordinator dashboard

| Area | Status |
| --- | --- |
| Summary cards — active trips, delayed, waiting, onboard, unresolved | ✅ |
| Trip board — driver, vehicle, progress, status | ✅ |
| Student exceptions — no-show, late change, missing check-in, unable to drop off | ✅ |
| Assignments — replace driver/vehicle before start, revalidate capacity | ✅ |
| Communication — route-wide or child-specific notification | ⚠️ Announcements go to **everyone**. Per-route and per-child targeting is not built. |
| Daily closeout — verify all trips complete and all statuses resolved | ✅ |

---

## 6. Administration, notifications, exceptions

### 6.1 Company administration

| Blueprint | Status |
| --- | --- |
| Create and deactivate users; assign roles | ⚠️ **Invite-based.** See the note below. |
| Create schools, hubs, vehicles, route templates | ✅ |
| Link parents to students | ✅ Either side proposes; the other accepts |
| Assign students to morning/afternoon/club routes | ✅ |
| Set cutoff times and notification preferences | ⚠️ Cutoffs are in the database and honoured; there is **no settings screen** to edit them yet — it is a SQL update |
| View simple reports and audit history | ⚠️ Reports yes; the **audit log has no viewer screen** yet, though every entry is being written |

> ### The one real change to §6.1: how an account is born
>
> The blueprint says the administrator *creates* users. Creating an auth account
> on someone's behalf means inventing a password and transmitting it, which is
> worse than the problem it solves.
>
> Instead:
>
> **Admin creates the user → issues an invite code → user signs up with it →
> the role is assigned from the invite → the app shows the right dashboard.**
>
> The outcome is the same and the control is the same. The admin still decides
> who exists and what they are. The person redeeming the code has **no say in
> their role** — the signup trigger reads it off the invite row and ignores
> anything the client sends. Tested: signing up with a *student* code while
> claiming `role: "admin"` produces a **student** account.
>
> A code is single-use, expires in 14 days, can be revoked, and can be locked to
> one email address. Only **admins** can issue them — a coordinator cannot,
> because issuing an invite is the same power as assigning a role.
>
> Admins cannot be invited at all: an admin invite must be created directly in the
> database. That is the bootstrap, and it means a stolen admin session cannot
> quietly mint another admin.

### 6.2 Notification matrix — all seven

| Event | Recipient | Status |
| --- | --- | --- |
| Student checked in | Driver and Coordinator | ✅ |
| Driver confirmed boarding | Parent | ✅ |
| Trip delayed | Affected parents | ✅ |
| Club change approved | Student, Parent, Driver | ⚠️ Goes to the **requester**, not all three |
| Approaching stop | Parent | ⚠️ No *push* for it. Since 10 Aug, with GPS on, the parent's card and the map show a live **"minutes away"** from the van's real position — so the information exists, it just is not a notification yet. With GPS off, the scheduled 15/5-minute alerts cover the same need with honest wording ("due in", not "away"). |
| Safe drop-off | Parent | ✅ |
| Unable to drop off | Coordinator and Parent | ✅ Marked URGENT |

### 6.3 Exception scenarios — all seven

| Scenario | Status |
| --- | --- |
| Student absent | ✅ Removed from the boarding list, kept in history |
| Parent pickup | ✅ Coordinator approves if late; the driver sees the status |
| Student no-show | ✅ Driver marks it; parent and coordinator notified |
| Driver absent | ✅ Coordinator assigns a substitute before the trip starts |
| Vehicle unavailable | ✅ Substitute assigned, capacity revalidated |
| Club cancelled | ✅ Affected assignments removed |
| Unable to drop off | ✅ Student stays onboard; coordinator must resolve; **the trip cannot close** |

---

## 7. Technical approach — where this diverges most

### 7.1 Data model

The blueprint suggests Firestore collections. This is **Postgres tables**. The
mapping is close, but two things differ:

**No `companyId`.** The blueprint is multi-tenant SaaS. You said this is one
transport operation with three vans, so there is a single `organization` row
instead of a company column on every table.

> ⚠️ **This is the one decision that does not scale by accident.** Onboarding a
> second company means adding `company_id` to every table and every RLS policy.
> If multi-tenancy is ever likely, it is much cheaper to do now than later.

**`auditLogs` and `changeRequests`** are present and match. `studentTripStatus` is
`student_trip_status`, `dailyTrips` is `daily_trips`, and so on.

### 7.2 Build sequence

The blueprint's recommended order was followed, except that the coordinator trip
board was built alongside the driver screens rather than after them — they share
the same trip data and were easier to get right together.

### 7.3 Architecture — three divergences

| Layer | Blueprint | Built | Why |
| --- | --- | --- | --- |
| Frontend | Responsive React **web** app | **Expo — iOS, Android, and web** | The blueprint wanted web so a coordinator could work at a desk. That is satisfied: the web build works and the layouts cap their width on a large screen. But drivers and students are on phones, where a native app is genuinely better, and you asked for all three platforms. |
| Auth | Firebase Authentication | **Supabase Auth** | Follows the database choice. |
| Database | Firestore + security rules | **Postgres + Row Level Security** | The §2.1 rules are the hard part of this product. In Postgres they are enforced *inside the database* and — crucially — can be **tested by attacking them directly**, with no app in the loop. Firestore rules can express the same thing but fail *open* when a clause is missed, and the only way to know is an emulator test suite. §7 says "may use" and explicitly allows a relational database. |
| Backend logic | Cloud Functions | **Postgres triggers + Edge Functions** | The trip-close guard, the cutoff decision, and the audit log are triggers, so **no write path can bypass them**. As Cloud Functions they would be application code that another path could route around. |
| Notifications | In-app, then FCM | In-app + Expo Push | Same shape. |
| Maps | Hub pins only; GPS postponed | Hub pins by default; live van **behind a flag** | As instructed — and the flag is now wired end to end rather than reserved, so the decision to enable it is a policy call, not a build. |

### Cost

§8's table is priced in Firebase. On Supabase, this pilot (30–40 students) sits
inside the **free tier: $0/month**, with $25/month Pro if it outgrows it — the
same ceiling §8 budgets for. One practical difference: Firebase requires a credit
card (Blaze) before you can deploy a Cloud Function at all, even at zero usage.
Supabase does not.

---

## 8. The two switched-off features

Both are **fully built**. Both are excluded by §1.2. The flags live in the
`organization` table, and an admin flips them in **Setup → Features** — no new
build required.

### Live GPS — `gps_enabled = false`

Wherever a map would be, the app shows a panel saying it is off and quoting the
blueprint sections that say so (§1.2, §7.3, §8), so nobody mistakes it for a
missing feature.

Behind the switch: the driver's phone reports its position while a trip is
active, **and** an open HTTP endpoint (`ingest-location`) accepts a `device_key`
and a bare lat/lng from any hardware tracker that can make an HTTPS POST. Both
write to the same table; nothing downstream knows which. You can drive a van
across the map with `curl` before any hardware exists.

With it on, parents and students get a live **"6 minutes away"** to their own hub,
computed from the van's actual position and the stops it still has to call at
first — which is the information §4.2's "Approaching" step was asking for.

> #### It is not continuous tracking, and that is enforced, not promised
>
> §1.2 rules out *continuous background location*. So collection is scoped to a
> running route by **four independent guards**, because one is not enough — a
> driver who forgets to tap **End trip** must not be followed home:
>
> 1. **Start is tied to the trip.** Nothing calls `startTracking()` except
>    starting a trip, or reopening a trip already running. The permission prompt
>    happens then, not at app launch.
> 2. **Opening the driver's home screen cleans up.** `enforceTrackingScope()`
>    stops a task left running for a trip that is no longer active — and opening
>    the app is the one thing a driver reliably does the next morning.
> 3. **The task stops itself.** A six-hour ceiling, plus it treats the database
>    refusing a row as authoritative: the RLS policy on `vehicle_locations` only
>    accepts a position for an `active` trip driven by that user, so a refusal
>    means the route is over and the phone shuts the sensor down — even if the app
>    is never opened again.
> 4. **The database is the backstop.** No position can be stored outside an active
>    trip the caller is driving, whatever the client does.
>
> And a **stationary van goes quiet**: reporting is triggered by movement (30 m)
> with a 90-second heartbeat, not a fix every ten seconds. iOS's own stationary
> pause is enabled (`pausesUpdatesAutomatically`, previously `false`) with
> `activityType: AutomotiveNavigation`. The heartbeat exists so the parent screens
> can tell *parked* from *lost signal* — a distinction they draw, so it has to be
> real. A van idling at a hub therefore costs almost nothing, which is the direct
> answer to §8's cost-and-battery condition.
>
> Position today comes from the driver's phone. A tracker fitted to the van posts
> the same rows through `ingest-location`, at which point the phone stops being
> involved and none of the app above this line changes.

### QR boarding — `attendance_mode = 'scan'`

Not a switched-off feature — it works, and the office chooses per organisation.

The student's Today screen shows a QR code, one per leg of the day. The driver
gets **"Scan students on"** at each stop once the van has arrived there, and the
camera stays open between students.

**The driver scans the student, never the reverse.** A code taped inside the van
that students scanned themselves would be a *self-reported boarding* — the one
thing §2.1 forbids, because a child can scan it from the pavement and then miss
the van. Because the driver's phone does the scanning, the write is still a driver
write and **no RLS policy changed** to enable any of this.

The code lives on the trip row, not the student, so it differs morning and
afternoon and yesterday's screenshot is worthless. A code scanned off a
classmate's phone identifies *that classmate* — the driver sees the wrong name and
stops.

A scan that does not belong to this trip gets a real answer rather than "unknown
code": `identify_boarding_code()` reports *"Priya rides Route 2 with Sam, not this
van"*, which is also how a child about to board the **wrong vehicle** gets caught.

Marking students on by name still works underneath. A flat phone has no QR and the
van still has to leave.

### One tap for the school gate — exception-based drop-off

Where two or more riders are still on board at their drop-off stop — in practice
the morning arrival at school — the driver gets **"All N dropped off safely"**.

Exceptions are marked **first**, and the count on the button falls as they are. So
the record names who did *not* get off, rather than asserting that everyone did.
Each rider still gets their own row, their own timestamp and their own parent
notification; this is one write, not one outcome.

Deliberately **not** applied to boarding. Bulk-marking children as present is a
claim about who is physically standing there; bulk-marking them off at a school
gate is not. Afternoon boarding is answered by scanning instead.

### Payments — `payments_enabled = false`

The screen says, as requested:

> **Blueprint does not include payment. Code is already written. Contact Abhigyan
> to enable the code.**

Behind the switch: invoices, payment history, balances, overdue flags, and
coordinator reminders. Records only — no card processing anywhere, so no PCI
surface.

---

## Beyond the blueprint: the weekly report and purge

Not asked for by the blueprint. Added because the blueprint's data model grows
without bound, and a pilot that runs a term would quietly accumulate tens of
thousands of rows saying *"the student boarded, the student was dropped off,
nothing happened"* — the overwhelming majority of the data, and almost none of
the value.

It also does most of the job of §1.1's *"daily trip history and a basic
exportable report"*, which was previously an open gap.

### How it works

An **administrator turns it on with a switch** (Setup → Data → "Enable weekly
purge"), which schedules the job — no cron SQL to paste into a dashboard.
Turning it off unschedules it, and nothing is purged while it is off. A
coordinator cannot flip it: scheduling a job that deletes data is an admin's
call, and the database enforces that rather than the UI.

Every **Sunday at 03:00**, once enabled (or on demand, from the same screen):

1. Each student's week is archived into **one** `weekly_reports` row.
2. That report is **sent** to the student and their parents.
3. **Only then** is routine detail older than the retention window purged.

The report **is** the history. Purging the rows underneath compacts a child's
record from ~10 rows a week to 1 — it does not erase it.

### Weekly job, 3-week retention — two different things

The job runs **every week**. What it deletes is anything older than
**`retention_weeks`** (default 3, adjustable to 2/4/8/12 in Setup → Data). So each
run sweeps up whichever week has just aged out.

| Week | What Sunday's run does to it |
| --- | --- |
| This week | Nothing — it is still running |
| Last week | **Report generated and sent** |
| 2–3 weeks ago | Kept in full detail |
| 4+ weeks ago | Routine detail **purged** (its report went out 3 weeks earlier) |

Note that the week being *reported* and the week being *purged* are not the same
week. A family has had the report for three weeks before the detail behind it
goes.

### What is never purged

- **Incidents** — delays, breakdowns, accidents. The safety record.
- **Any trip where a student was a no-show or could not be dropped off** — kept
  **whole**, every row of it. The question afterwards is always *"what happened on
  that run"*, not *"what happened to that one child"*.
- **Coordinator overrides**, and the reason given for each (§2.1).
- Absences, parent pickups, club changes.
- The weekly reports themselves, and all configuration.

### What is purged, once archived

- Ordinary rides on trips where nothing went wrong.
- **GPS breadcrumbs** — by far the largest table when tracking is on, at roughly
  one row every few seconds per van.
- Notifications already read.
- Routine status changes carrying no reason.

### The guard that makes it safe

Three conditions must **all** hold before a row is deleted:

1. It is older than `retention_weeks`.
2. Its trip is not notable.
3. **Its week has a report.**

The third is the one that matters. **No report, no deletion — even if the data is
ancient.** A cron misfire, or someone lowering the retention setting, cannot
delete a week that was never sent to anybody.

### Verified

Against a real Postgres, with data six weeks old:

| Check | Result |
| --- | --- |
| Reports generated and the parent notified | ✅ *"Sam — 5 rides… 4 completed, 1 no-show"* |
| GPS breadcrumbs purged | ✅ 500 → 0 |
| Routine rides purged | ✅ 6 rows |
| The no-show Wednesday kept **whole** | ✅ |
| The incident Friday kept **whole** | ✅ |
| An old but **unreported** week | ✅ **untouched** |
| A parent reading another child's report | ✅ refused by RLS |

Lives in [`supabase/retention.sql`](../supabase/retention.sql) — purely additive,
and safe to run against a live database.

---

## 9. Acceptance scenarios (§9.1)

| Scenario | Status |
| --- | --- |
| Normal morning trip | ✅ **Verified end-to-end against a real database** |
| Normal afternoon trip | ✅ Same mechanism, reversed stop order |
| Club route | ⚠️ Supported — a club trip seats only approved attendees — but not yet driven with real accounts |
| Same-day absence | ✅ Verified: an absence before the cutoff auto-approves and the roster reflects it |
| Late parent pickup | ✅ Verified: after the cutoff it queues as Pending for the coordinator |
| No-show | ✅ Driver marks it; parent and coordinator notified |
| Driver substitution | ⚠️ Supported — a coordinator reassigns before start — but not yet driven with real accounts |
| Unable to drop off | ✅ **Verified: the trip cannot close** |

## 9.3 Is the MVP complete?

The blueprint's definition: *all eight scenarios work, each role sees only
authorised information, every student ends with a final status, and volunteers can
complete the workflow without developer assistance.*

- **All eight scenarios** — supported. Six verified; two need a real run.
- **Each role sees only authorised information** — verified by attacking the
  database directly as a student, a parent, and a suspended user.
- **Every student ends with a final status** — enforced; the database will not
  allow otherwise.
- **Volunteers can complete the workflow unaided** — **not yet demonstrated.**
  This is the honest gap. It needs a real pilot with real people, which is
  exactly what §9 asks for and what no amount of code can substitute for.

## The gaps, gathered in one place

Nothing here is hidden elsewhere in this document.

### Against the blueprint

1. **No CSV export** (§1.1) — partly closed. Every family now gets a weekly report
   in the app (see above), which covers "a basic report". Nothing writes a
   downloadable **file** yet.
2. **No student photos on the driver roster** (§5.1) — a privacy decision for you, not me.
3. **No photo attachment on incidents** (§5.1).
4. **"Approaching" as a GPS-derived notification** (§6.2) — the live ETA exists on
   screen with GPS on, and scheduled "due in 15 / 5 minutes" alerts now push from
   the server. What is still missing is the *position*-derived version, which is a
   change to one query once GPS is on for real.
5. **Club-change notification** reaches the requester, not student + parent + driver (§6.2).
6. **No `companyId`** — single-tenant. The expensive one to change later.
7. **NFC not built.** The `attendance_mode` flag has two values, `manual` and
   `scan`, and `scan` means QR. QR needs no hardware and works on every phone.
8. **No SMS fallback.** Urgent notifications now record delivery and demand
   acknowledgement, and the watchdog escalates silence to the office — but the
   final hop is still a person picking up a phone, not an automated SMS. That
   needs a provider decision.

Closed since the last revision of this list: the check-in window is now enforced
in the student's RLS policy (§4.1); cutoff times have a settings screen (§6.1);
the audit log has a viewer (§6.1); announcements are route- and child-targeted
(§5.2).

### Found by the 10 August flow review

A design review stress-tested the ride flow and found 22 problems the blueprint
never raised, several of them safety-critical. They have their own document:

> ### 📋 [**The remediation plan →**](REMEDIATION.md)

As of **12 August 2026, twenty-one of the twenty-two are closed.** The one that
is not is **C3, the offline queue** — a dead zone still loses driver actions
until they reconnect, and the app does not yet queue them. It is deliberately
last: the plan sequences it "once the safety work is not waiting on it", which is
now true, and a half-built sync layer that drops or reorders writes would be
worse than none in an app about where children are.

The remediation document carries a full checklist at the bottom.

---

## The rider state machine

RLS decides **who** may write **which** status. Until 12 August nothing decided
**what may follow what** — so a raw API call with a driver's token could move a
rider straight from `scheduled` to `dropped_off`, never boarded, never on the
van, and every downstream consumer would have accepted it.

`guard_rider_transition()` holds this table. Anything not in it is refused.

| From | May become |
| --- | --- |
| `scheduled` | `waiting`, `boarded`, `absent`, `parent_pickup`, `no_show` |
| `waiting` | `boarded`, `absent`, `parent_pickup`, `no_show` |
| `boarded` | `in_transit`, `dropped_off`, `parent_pickup`, `unable_to_drop_off` |
| `in_transit` | `dropped_off`, `unable_to_drop_off` |
| `dropped_off` | `completed` |
| `absent` | `boarded` |
| `parent_pickup` | `boarded` |
| `no_show` | `boarded` |
| `unable_to_drop_off` | `dropped_off` |
| `completed` | — terminal |

Three things this table encodes that are worth saying out loud:

- **The away → `boarded` edges are deliberate.** A child recorded as absent who
  turns up is the exact state this app exists to prevent, so it has to be
  *recordable* rather than prevented — the driver takes them either way. The
  database separately refuses that write without a note.
- **`boarded` → `parent_pickup`** is a parent arriving at the hub and taking a
  child back off the van before it leaves. It happens.
- **Staff are exempt**, because §2.1 already gives them override authority and
  already demands a reason for it. So is an explicit undo, which is a compensating
  action rather than a forward move.
