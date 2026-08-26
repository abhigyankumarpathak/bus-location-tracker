# What we need before the first run

Everything the app has to be told before it can carry a single child, and who
owns each piece. Nothing here is optional unless it says so.

Grouped by **who has to produce it**, not by which screen it goes into — the
point is to be able to hand sections 1–3 to the driving company and section 5 to
the school and get usable answers back.

---

## 1. The fleet — *driving company*

One row per vehicle. Retired vans stay in the system rather than being deleted,
so old trips still name the van that ran them.

| Field | Notes |
| --- | --- |
| **Label** | What drivers and families actually call it — "Van 1", "the blue one". This is what parents see. |
| **Registration plate** | For the office and for incident reports. |
| **Seat capacity** | The app warns the office when a roster exceeds it. A wrong number here means either a false warning every day or no warning when it matters. |
| **Which route it normally runs** | Sets the default so the office is not assigning vehicles by hand every morning. |
| **Spare / relief vehicles** | List them too. A substitute van with no record cannot be assigned mid-incident. |

## 2. The drivers — *driving company*

| What | Notes |
| --- | --- |
| **Full name and email address** | One invite per person. **No shared logins** — the record of who confirmed a child aboard is the whole product, and a shared account destroys it. |
| **Contact phone number** | For the office, when an urgent alert goes unanswered. |
| **Who normally drives which route** | Sets the default assignment. |
| **Substitute arrangements** | Who covers when someone is off, and **how the office finds out**. A trip with no driver assigned is a trip nobody can start. |

**Personal phones — confirmed, and it has consequences.** Nothing about the
device can be mandated, so we need each driver to agree to:

- a working mobile data plan on the days they drive;
- **notifications turned on** for the app;
- **background location permission** ("Always", not just "While Using") — with
  "While Using" the van only appears on the family map while the driver is
  staring at the screen;
- a **charger and a mount** in the cab. Battery is now a safety dependency, and
  it is better to say so than to discover it.

The app degrades honestly if any of these are refused — it tells the driver and
the families what is off and why — but the feature is genuinely gone.

## 3. The schedule — *driving company, with the school*

**This is the largest single thing we need, and the app cannot run a route
without all of it.** For every route, in every direction:

- **Route name** and **type** — morning, afternoon, or after-school club.
- **Which school** it serves.
- **Which days of the week it runs** (e.g. Monday–Friday). Per route, so a club
  van that only runs Tuesdays and Thursdays is expressible.
- **The ordered list of stops**, first to last, including the school as one of
  them. Order matters: the driver's screen unlocks each stop only when the
  previous one has been left.
- **For each stop, a planned arrival time and a planned departure time.**
  Wall-clock local times.

Those planned times are not decoration. They drive the *"van due in 15 minutes"*
alerts families get, the ETA on the map, and every threshold the watchdog uses to
notice a route that has silently failed. **Guessed times produce either constant
false alarms or no alarms at all.**

## 4. The stops themselves — *driving company, with the school*

| Field | Required? | Notes |
| --- | --- | --- |
| **Name** | Yes | As a family would say it — "Oak Road", not "Stop 3". |
| **Exact street address** | Strongly recommended | The "which corner exactly" line. Parents see it; without it they get a name and nothing else. |
| **Latitude and longitude** | **Yes — mandatory** | The database will not accept a hub without them. No coordinates means no map pin, no ETA, and no arrival alerts for that stop. The office can geocode from an address, but it must be checked — a pin on the wrong side of a dual carriageway is worse than no pin. |

## 5. The riders — *school*

Per student:

- Full name and an email address for the invite.
- School and year/grade.
- **Morning hub and afternoon hub** — they are often different.
- **Which route they ride each way**, and **which stop they board at and get off
  at** for each leg.

Per guardian:

- Full name and email address.
- **Which children they are responsible for.** A guardian link has to be accepted
  by the student's side or approved by the office; that is what stops anyone
  attaching themselves to a child.

## 6. The operating calendar — *school* · ⚠️ **known gap**

**The app has no holiday calendar.** It generates trips for any date matching a
route's weekday pattern, so on a half-term Tuesday it will create a full set of
trips, nobody will drive them, and the watchdog will tell the office that **every
route failed to start** — which is exactly how a coordinator learns to ignore
alerts.

Two ways out, and one has to be chosen before term starts:

1. **Operationally:** the office deactivates the affected routes over each
   holiday and reactivates them after. Free, works today, relies on somebody
   remembering.
2. **Build a term-date calendar.** Small piece of work, removes the failure mode
   permanently. Not currently scheduled.

Either way we need **term dates, half-terms, inset days and bank holidays** for
the year.

## 7. Two measurements nobody has taken — *driving company*

- **Time the two known dead spots.** Someone drives each route with a stopwatch
  and records how long the phone is genuinely without signal at each one.
  <br>*Why it matters:* the watchdog's patience has to exceed the longest
  crossing, or the office gets a false alarm every single run. The driver's app
  now queues its writes through a dead spot and sends them afterwards, so no data
  is lost either way — but the alert thresholds are still guesses until this
  number exists.
- **Confirm the timings above against a real run.** Planned times taken from a
  timetable rather than a stopwatch are the most common source of nuisance
  alerts.

## 8. Decisions for the transport office

All of these are switches in **Setup**; they need answers, not code.

| Setting | Default | The question behind it |
| --- | --- | --- |
| **Time zone** | `UTC` — **must be changed** | A region name like `America/New_York`, never an abbreviation. Get this wrong and the alerts, the check-in window, the change cutoff and the watchdog are *all* wrong by the same number of hours. |
| **Attendance mode** | Manual | Manual (driver taps each name) or Scan (students scan the printed card in the van). |
| **Live GPS** | Off | Puts the van on the family map with a real ETA. |
| **Change cutoffs** | 06:30 / 13:30 | When a parent can still report an absence without the office intervening. |
| **Check-in window** | 60 min | How long before the van a student may tap "I'm at the hub". |
| **Undo window** | 90 sec | How long a driver has to take back a mistap. |
| **Watchdog thresholds** | 10 / 15 / 20 / 120 / 15 min | See §7 — these depend on the dead-spot timings. |
| **Retention** | 3 weeks | How long routine ride detail is kept. See §10. |

## 9. In the vehicle — *driving company*

- **A printed, laminated boarding card per van**, fixed by the door at a height a
  student can reach with a phone. We supply the artwork from Setup → Fleet.
  *(Only needed if scan mode is switched on.)*
- **A phone mount and a charger** in the cab.
- **Who replaces a damaged or missing card**, and how they tell the office. A
  card that has been photographed or shared can be reissued from Setup, which
  invalidates the old one immediately — so the replacement must be printed and in
  the van before the next run.

## 10. Escalation — *driving company and school, jointly*

- **Who does the office call** when an urgent alert goes unacknowledged? The two
  urgent cases are a child who checked in but was not picked up, and a child who
  could not be dropped off. Both escalate automatically; both then need a human
  with a phone.
- **What does a driver do when the app refuses something?** The red banner means
  a record did not save and nobody else knows about it. There needs to be a
  number they call, and an expectation that they do.
- **Out-of-hours contact** for both sides.

---

## Still open — flagged, not solved

Three things that are not blocked on the driving company but should be settled
before real families depend on this.

- **No SMS provider has been chosen.** Urgent notifications record their delivery
  and escalate when unacknowledged, but the escalation currently ends at the
  in-app inbox and a phone call. An SMS fallback needs a provider decision and an
  account.
- **The jurisdiction's record-keeping requirement for child transport custody is
  unknown.** The weekly purge deletes routine ride detail after the retention
  period (default three weeks) once it has been archived into a family report;
  incidents and overrides are kept forever. **If the law requires a longer
  custody record, this is a compliance problem — and the fix is small, but only
  while the data still exists.** Worth answering before the first purge runs on
  real data.
- **Do all riders actually have phones?** Self-scan boarding assumes they do. If
  a meaningful share do not, scanning is not an attendance system on its own and
  the driver's manual roster stays primary — which is a different conversation
  with the drivers about how long a stop takes.
