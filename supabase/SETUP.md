# Supabase setup

Everything the app needs, in order. About fifteen minutes.

Steps 1–4 give you a fully working pilot. Steps 5–7 add the staff portal password
and push notifications.

> **Upgrading from an earlier build?** The data model changed completely (hubs,
> route templates, daily trips, invites). Re-run `schema.sql` — it drops and
> recreates everything. Existing test accounts will need to be re-invited.

---

## 1. Create the project

Sign up at [supabase.com](https://supabase.com) and create a project. Free tier is
fine. Wait for it to finish provisioning.

## 2. Create the tables

**SQL Editor → New query**, paste in all of [`schema.sql`](./schema.sql), Run.

That is every table, the RLS policies, the trip generator, and the triggers that
enforce the blueprint's safety rules.

Supabase will warn that the query is destructive. It is — the file starts with
`drop table if exists …`, so it is safe to re-run while setting up and
destructive once you have real data. On a fresh project there is nothing to lose.

Then run [`seed.sql`](./seed.sql) for one school, three vans, four neighbourhood
hubs, and a Morning / Afternoon / Club route.

## 3. Point the app at the project

**Project Settings → Data API** for the **Project URL**, and **Settings → API
Keys** for the **publishable** key (`sb_publishable_…`, called `anon` on older
projects).

```sh
cp .env.example .env
```

Put them in. The URL is the bare `https://xxxx.supabase.co` — **no `/rest/v1` on
the end**; the client appends that itself.

```sh
npx expo start --clear
```

The `--clear` is not optional: Expo bakes `EXPO_PUBLIC_*` into the bundle, so a
warm cache keeps serving the old values.

> The publishable key is meant to ship in the app. It grants nothing on its own —
> RLS decides what each signed-in user can read. The **secret / service_role** key
> is the dangerous one; it bypasses RLS entirely. Never put it in `.env`.

## 4. Turn off email confirmation (development only)

**Authentication → Sign In / Providers → Email** → turn off *Confirm email*.
Otherwise every test account needs a real inbox. Turn it back on before real
families use this.

---

## 5. Become the administrator

**You cannot sign up without an invite code.** That is the point:

> Admin creates the user → user receives a code → user signs up → the role is
> assigned → the app shows the right dashboard.

Which leaves one problem: the first admin has nobody to invite them. `seed.sql`
solves it with a single bootstrap invite:

```
BUS-ADMN-0001
```

Open the app → **"I have an invite code"** → enter it → fill in your details.
You are now the administrator. Sign in, and the portal password screen appears.

From here on, **every other account is invited from the app** (People → Invites).
Pick a role, give a name, and the app produces a code you can copy or text. Codes
are single-use, expire in 14 days, can be revoked, and can be locked to one email
address.

If the bootstrap invite lapses before you use it, make another:

```sql
insert into invites (role, full_name, note)
values ('admin', 'Administrator', 'replacement bootstrap');

select code from invites where role = 'admin' and used_at is null;
```

**Admins can only be created this way — in the database.** The app will not invite
one, even for an admin. That means a stolen admin session cannot quietly mint a
second administrator, and it is what makes the portal password worth having.

A coordinator (runs the day, but cannot invite people or change settings) *can* be
invited from the app.

## 6. Deploy the Edge Functions

```sh
npm install -g supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy
supabase secrets set ADMIN_PORTAL_PASSWORD='pick-something-long'
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected
automatically — you do not set those.

| Function | What it does | Needs a login? |
| --- | --- | --- |
| `admin-unlock` | Checks the portal password | Yes — coordinator or admin |
| `admin-delete-user` | Removes an account, leaving them a message | Yes — admin only |
| `send-push` | Turns a `notifications` row into a real push | No — called by a DB webhook |
| `ingest-location` | GPS from hardware trackers (**disabled feature**) | No — device key |

Without `admin-unlock` deployed, the staff portal cannot be opened at all.

## 7. Push notifications (optional)

Alerts already appear in-app. To deliver them when the app is closed:

**Database → Webhooks → Create a new hook**

- Table `notifications`, event `Insert`
- Type: **Supabase Edge Functions** → `send-push`
- HTTP header: `Authorization: Bearer <your service role key>`

That header is how `send-push` knows the request came from your database. Push
also needs an EAS project and a physical device — the simulator cannot receive it.

## 8. Generate the day's trips automatically (recommended)

Blueprint §3: "the system creates daily trips from the appropriate templates."

The app calls `ensure_daily_trips()` whenever a driver, student, parent, or
coordinator opens it, so the pilot works with no cron at all. But if nobody opens
the app before 6am, the coordinator's dashboard is empty until someone does. To
create them on a schedule, enable `pg_cron`:

**Database → Extensions** → enable `pg_cron`, then:

```sql
select cron.schedule(
  'nightly-trips',
  '0 4 * * *',                      -- 04:00 daily
  $$ select ensure_daily_trips(current_date) $$
);
```

It is idempotent — running it twice creates nothing extra.

---

## What protects what

- **RLS is the real boundary.** Every policy keys off `auth.uid()`. It holds
  against `curl`, not just against the app.
- **Nobody picks their own role.** The signup trigger reads it off the invite and
  ignores whatever the client claims. Signing up with a student code while
  sending `role: "admin"` produces a student account — tested.
- **No code, no account.** A signup with a missing, unknown, used, expired, or
  revoked code raises, and the auth user is rolled back with it.
- **Invites are admin-only.** Issuing one is the same power as assigning a role,
  so a coordinator cannot do it.
- **A suspended account sees nothing.** `my_role()` only returns a role for an
  `active` profile, so every role-dependent policy fails closed.
- **A student cannot mark themselves boarded.** Their RLS policy permits exactly
  one target status: `waiting`. Blueprint §2.1 — "Student-submitted check-in
  means 'I am waiting'; it does not prove the student boarded." A parent cannot
  do it either. Only the assigned driver, and a coordinator with a written
  reason.
- **A driver only sees their own trips**, enforced in Postgres.
- **Admins cannot be created from the app**, per step 5 — an admin invite has to
  be written into the database.
- **A trip cannot close with a student unaccounted for.** A database trigger
  refuses it.
- **Every status override is logged** to `audit_logs` with the reason.

## The two switched-off features

Both are fully built and sitting behind a flag in the `organization` table,
because the blueprint excludes them from the first release. An admin flips them
in the portal (Setup → Features), or:

```sql
update organization set gps_enabled = true where id = 1;       -- blueprint §1.2, §7.3, §8
update organization set payments_enabled = true where id = 1;  -- blueprint §1.2
```

With GPS on, `ingest-location` becomes live. Get a van's device key:

```sql
select v.label, d.device_key
from vehicles v join vehicle_devices d on d.vehicle_id = v.id;
```

```sh
curl -X POST "https://<ref>.supabase.co/functions/v1/ingest-location" \
  -H 'Content-Type: application/json' \
  -d '{"device_key":"<key>","lat":37.3349,"lng":-122.0090}'
```
