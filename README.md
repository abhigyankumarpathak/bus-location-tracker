# Student Transportation Platform

[![Run on Replit](https://replit.com/badge/github/abhigyankumarpathak/bus-location-tracker)](https://replit.com/new/github/abhigyankumarpathak/bus-location-tracker)

An Expo app for a school transport operation: one school, three vans, and the
people who depend on them. Students, parents, drivers, and the transport office
each get their own section of the same app.

Built to the **MVP Functional Blueprint**, on Supabase (Postgres, Auth, Realtime,
Edge Functions).

The goal, in the blueprint's words, is *"reliable visibility from planned pickup
through confirmed safe drop-off"* — and everything below exists to make that
sentence true even when things go wrong.

> ### 📋 [**What is built, and how it compares to the blueprint →**](docs/FEATURES.md)
>
> Every blueprint section, checked off one by one: what is built, what differs and
> why, and **ten gaps stated plainly**. Read this one if you have the blueprint in
> front of you and want to know whether we built what you asked for.
>
> Also: [setup guide](supabase/SETUP.md) · [the database](supabase/schema.sql) ·
> [weekly report and purge](supabase/retention.sql)

## The rule that shapes everything

> **A student checking in means "I am waiting at the hub." It does not mean "I
> boarded."**

Only the driver can mark a student Boarded or Dropped Off, and that is the
official record. This is enforced in Postgres, not just in the UI — a student's
RLS policy permits exactly one target status, `waiting`. A parent cannot do it
either.

It matters because the alternative is silent and dangerous: a child taps "I
boarded", misses the van, and the school believes they are safely aboard. The
blueprint is explicit (§2.1), and the app takes it literally.

## How you get an account

> **Admin creates the user → user receives a code → user signs up → the role is
> assigned → the app shows the right dashboard.**

There is no role picker. **Nobody chooses what they are.** An admin issues an
invite from the portal, the invite carries the role, and the signup trigger reads
it off the invite row — ignoring anything the client sends. Signing up with a
*student* code while claiming to be an admin produces a **student** account.

No code means no account at all: a signup with a missing, unknown, used, expired,
or revoked code raises, and the auth user is rolled back with it.

| Role | Sees | Invited by |
| --- | --- | --- |
| Student | Own trip only | Admin |
| Parent | Linked children only | Admin |
| Driver | Own assigned trips only | Admin |
| Coordinator | All daily operations | Admin |
| Admin | Everything, plus configuration | **Database only** — the app will not invite one |

Codes are single-use, expire in 14 days, can be revoked, and can be locked to one
email address. Only admins can issue them, because issuing an invite is the same
power as assigning a role.

Admins are the exception: an admin invite has to be created in SQL. That means a
stolen admin session cannot quietly mint a second administrator — and it is what
keeps the portal password worth having. `seed.sql` ships one bootstrap invite so
the first admin can get in.

## What each role does

**Student** — Today (route, hub, planned time, driver's first name, vehicle,
status, Check In), Club Status, History, read-only Profile.

**Parent** — a card per child with the live status and next expected event, the
full trip timeline (Scheduled → Waiting → Boarded → In Transit → Dropped Off →
Completed), Daily Change (absence, parent pickup, club), alerts, and history.

**Driver** — today's assigned trips, trip overview with capacity warnings, the
stop roster grouped by hub, per-student actions (Boarded, No-Show, Absent, Parent
Pickup, Dropped Off Safely, Unable to Drop Off), incident reporting, and the End
Trip checklist.

**Transport office** — summary cards, the trip board with driver assignment, the
exception queue, invites (create a user, choose their role, hand them a code), and
configuration of hubs, vans, routes, and who rides them.

## Things the database refuses to allow

These are not UI checks. They are triggers and policies, and they hold against a
raw API call:

- A student or parent writing `boarded` or `dropped_off`.
- A driver ending a trip while any student is still Scheduled, Waiting, Boarded,
  or In Transit. *"Cannot end the trip: 2 student(s) still have no final status."*
- A driver closing a trip with an unresolved **Unable to Drop Off** — that one
  needs a coordinator.
- Anyone changing their own role or account status.
- A pending or suspended account reading anything.
- A coordinator approving accounts or changing settings (admins only).
- A status override without a reason — it is written to `audit_logs` either way.

Cutoffs are enforced server-side too: a change request before the cutoff applies
immediately, and after it the database marks it Pending for a coordinator. The
client does not get a vote.

## The weekly report, and the purge

Every **Sunday** each student's week is archived into a single report and **sent to
them and their parents**. Only *then* is the routine detail behind it purged.

The report **is** the history — purging the rows underneath compacts a child's
record from ~10 rows a week to 1, it does not erase it.

The job runs **weekly**; what it deletes is anything older than **`retention_weeks`**
(default 3, set in Setup → Data). So the week being *reported* and the week being
*purged* are never the same week — a family has had the report for three weeks
before the detail behind it goes.

**Never purged:** incidents; any trip where a student was a **no-show or could not
be dropped off**, kept *whole*, every row of it; coordinator overrides and the
reason for each; absences and pickup changes; all configuration.

**Purged once archived:** ordinary rides where nothing happened, GPS breadcrumbs,
read notifications, routine status changes with no reason.

**The guard:** a week is never purged unless a report for it exists. *No report, no
deletion* — even if it's ancient. A cron misfire cannot delete a week nobody saw.

Lives in [supabase/retention.sql](supabase/retention.sql) — additive, and safe to
run against a live database.

## Two features that are built but switched off

The blueprint excludes both from the first release. The code is complete and
working; the flags live in the `organization` table and an admin flips them in
Setup → Features. Nothing was thrown away.

**Live GPS** — driver phone streaming *and* an open HTTP endpoint any hardware
tracker can POST to (`ingest-location`). Wherever the map would be, the app shows
a panel saying it is off and quoting the blueprint sections that say so
(§1.2, §7.3, §8). You can drive a van across the map with `curl` once it is on.

**Payments** — invoices, history, balances, overdue flags, reminders. The screen
shows: *"Blueprint does not include payment. Code is already written. Contact
Abhigyan to enable the code."*

## Run it on Replit (no Mac needed)

[![Run on Replit](https://replit.com/badge/github/abhigyankumarpathak/bus-location-tracker)](https://replit.com/new/github/abhigyankumarpathak/bus-location-tracker)

The fastest way for a collaborator to see the app without installing anything.

1. Click the badge. Replit forks the repo and installs the dependencies.
2. Open the **Secrets** tab (🔒) and add the two Supabase values:
   - `EXPO_PUBLIC_SUPABASE_URL` — Project Settings → Data API
   - `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — Project Settings → API Keys
3. Press **Run**. The app opens in the browser pane.

Without the secrets it still starts — you get a "Connect Supabase" screen rather
than a crash, and the console says what is missing.

> **Replit runs the WEB build only.** It is a Linux container, so there is no iOS
> or Android simulator on it. That is not a reduced version of the app — every
> role, screen, and rule is there. Only push notifications are missing, because
> browsers have no `expo-notifications`; alerts still land in the in-app inbox.
>
> A browser is also where a transport coordinator actually belongs (blueprint
> §7.3 asked for exactly this), so the web build is the *right* target for the
> people most likely to be reviewing your work.

**Share the publishable key with collaborators freely.** It grants nothing on its
own — Row Level Security decides what each signed-in user can read, and Postgres
enforces that no matter who holds the key. Never put the **secret / service_role**
key in Replit: it bypasses RLS entirely, and anything in `EXPO_PUBLIC_*` is
compiled into the page every visitor downloads. The preflight script refuses to
start if it spots one.

## Three platforms, one codebase

iOS, Android, and the web all ship from the same source.

```sh
npm install
npx expo run:ios        # iOS     — needs a Mac with Xcode
npx expo run:android    # Android — needs Android Studio
npm run web             # Web     — opens in the browser, works anywhere
```

Then follow [supabase/SETUP.md](supabase/SETUP.md) — the app boots to a setup
screen until it has a project to talk to.

Day to day, once installed: `npx expo start`, then `i` / `a` / `w`.

**The web build matters for the transport office.** Blueprint §7.3 wants a
coordinator working at a desk, not running the trip board off a phone. Screens
cap their reading width on a wide display rather than stretching to 1400px.

Push notifications are the one thing web loses (there is no `expo-notifications`
in a browser). Everything still lands in the in-app inbox on every platform.

### Supabase, not Firebase

The blueprint (§7) suggests Firebase and Firestore — it says "may use", and
explicitly allows a relational database. This is built on **Supabase** (Postgres),
because the §2.1 safety rules are the hard part of this product and Postgres lets
them be enforced *inside the database* and then tested by attacking it directly.
See [docs/FEATURES.md](docs/FEATURES.md) for the full comparison against the
blueprint.

## Layout

```
app/                    Screens (expo-router; the folder IS the routing)
  _layout.tsx           Role guards + the pending-approval gate
  sign-up.tsx           The role picker
  unlock.tsx            Staff portal password
  (student)/ (parent)/ (driver)/ (staff)/
src/
  lib/auth.tsx          Session, profile, approval state
  lib/org.tsx           Feature flags (GPS, payments)
  lib/hooks.ts          Reference data, trip statuses, notifications
  lib/tracking.ts       Driver GPS — built, disabled
  components/Disabled.tsx  The "not in the MVP" panels
supabase/
  schema.sql            Tables, RLS, triggers, ensure_daily_trips()
  seed.sql              One school, three vans, four hubs, three routes
  functions/            Edge Functions
  SETUP.md              Read this
```

## Known limits and deliberate omissions

- **Supabase, not Firebase** — §7 says "may use", so this is allowed, but it is a
  deviation. See [docs/FEATURES.md](docs/FEATURES.md).
- **Single organisation.** The blueprint describes multi-tenant SaaS with a
  `companyId` on every record. This is built for one operation with three vans,
  so there is a single `organization` row instead. Onboarding a second company
  means adding that column everywhere — it is the one thing here that will not
  scale by accident.
- **No Platform Super Admin.** Not useful with one company.
- **No vehicle-to-vehicle transfers at hubs** — excluded by §1.2.
- **No turn-by-turn navigation** — excluded by §1.2. The driver hands off to the
  phone's own maps app.
- **Daily trips** are generated on demand when anyone opens the app, and
  optionally by `pg_cron`. See SETUP.md §8.
- **Push** needs an EAS project and a real device; without it, notifications
  still appear in-app.

## Native folders are generated

`ios/` and `android/` are gitignored — they are generated from `app.json` by
Expo prebuild. Native config goes in `app.json` or it gets overwritten.
