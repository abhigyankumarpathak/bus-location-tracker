# Security

What protects families' data in this app, what does not yet, and how to check.
Written for the parents who asked, so it says what is true rather than what is
reassuring. **Last reviewed 14 September 2026.**

---

## The short version

- **Every table is locked at the database, not the app.** A student can read
  their own records, a parent their children's, staff everything. This is
  enforced by Postgres on every query regardless of what any client sends, so a
  modified app, a curl command, or a bug in a screen cannot read past it.
- **Nobody chooses their own role.** Accounts come only from an invite code an
  administrator issues, and the invite carries the role. Signing up with Google
  does not change that — you still present the code.
- **Nothing that ships to a phone or browser has a known vulnerability.** The
  26 advisories `npm audit` reports are all in the build pipeline (`metro`,
  `@expo/cli`, `browserslist`), which never runs on a user's device.
- **The one secret that would unlock everything never leaves the server.** The
  service-role key is not in the app bundle, and the deployment scripts refuse
  to start if somebody puts it there.
- **Three things are weaker than they should be**, and they are listed below
  rather than left for someone to find. The first of them was a deliberate
  trade taken this month and can be reversed in one line.

---

## What is in place

### Row Level Security on every table

Supabase runs Postgres, and every table in [`schema.sql`](../supabase/schema.sql)
has `enable row level security` with explicit policies. The important ones, in
the words of the policies themselves:

| Data | Who can read it |
| --- | --- |
| A student's ride and attendance records | That student, their linked guardians, and staff |
| A vehicle's live position | Riders on that vehicle's trip *today*, their guardians, and staff |
| The register (who has been marked) | Staff only |
| Vehicle credentials (`device_key`, `board_code`) | Admins only, via functions that return one field |
| Another person's profile | Only when a family link exists, or you are staff |

This is the layer that matters. The app is a convenience for reaching the
database; the database is what decides.

### Roles come from invites, never from the user

`handle_new_user()` refuses to create a password account without a valid invite
code, and the role is copied **from the invite**, not from anything the person
submits. A trigger (`guard_privileged_columns`) then refuses any attempt by a
non-admin to change a role or status, including their own.

For social sign-in this became two steps rather than one — sign in, then claim
the invite — and the reason is in the next section.

### Sensitive writes go through one door each

Anything a student or parent can do that touches another person's record is a
`security definer` function with its own checks, not a table they can write to:

- `board_by_vehicle_code()` — refuses unless the van is at that student's own
  stop, right now.
- `mark_attendance()` — refuses before the evening cutoff and against a wrong
  code.
- `declare_absence()` — a parent for their own children, a student for
  themselves, nobody for anyone else.
- `claim_invite()` — the same invite checks as a password signup, applied to a
  social one.

Each has `revoke execute … from public, anon` and a narrow grant. The trigger
functions that need to read past RLS have execute revoked from *everyone*, so
they cannot be called over the API at all.

### Credentials are kept where the wrong people cannot read them

`vehicles` is readable by every signed-in user (students pick their bus from
it), so the GPS credential lives in `vehicle_devices`, which is admin-only. The
printed attendance code lives in `attendance_code` for the same reason. This is
a recurring pattern in the schema and it is deliberate: RLS is row-level, not
column-level, so a secret on a readable table is a readable secret.

### The portal is two locks, not one

Staff screens need a coordinator or admin *account* **and** a separate portal
password, checked on the server in constant time. An admin account that leaks
cannot open the portal; the password without an account opens nothing.

### Every override is written down

Staff overrides, code reissues, family links the office makes, manual
attendance marks — each writes to `audit_logs` with who, when and why. Routine
records are purged after three weeks; overrides and incidents never are.

### Transport

Render and Supabase both enforce HTTPS. Auth uses the PKCE flow, so a session
token never travels in a URL where browser history or an OS log could keep it.

---

## What is not, and should be said out loud

### 1. A family link takes effect without the child's consent

**This is the one to discuss.** Until 3 September a link between a parent and a
student sat pending until the *student* accepted it. That handshake was removed
because a student with no phone can never accept, so the office was left with
links nobody could complete.

The cost: `find_user_by_contact()` matches on email or phone, so **any parent
account that knows a student's email can link to them and immediately read that
student's attendance and history.** Nothing asks the student. Two things narrow
it — the student and every coordinator are notified the moment it happens, and
anyone involved can undo it in one tap — but a parent who does not open the app
that evening has been read by a stranger for a day.

**The fix is one line** — drop the `on_link_proposed` trigger — and it does not
bring the dead end back: the office can now approve waiting links from the
Riders screen, which is the authority the handshake was standing in for. The
recommendation is to do that before real families are on the system.

### 2. The printed attendance code does not rotate

A photograph of it marks its holder attended from anywhere, on any evening,
until an administrator reissues it. The evening cutoff narrows the window; it
does not close it. A rotating on-screen code was offered and declined for
operational simplicity. Worth revisiting if the numbers ever look wrong.

### 3. No second factor, and no self-service password reset

A stolen password is enough to sign in. Staff accounts are protected by the
portal password as a second gate; family accounts are not. And there is no
"forgot password" flow — a reset today means the office running SQL. Social
sign-in helps with both, because the provider's own recovery and 2FA apply.

### Smaller items

- The portal password is one shared secret. It should be rotated when staff
  leave, and there is no screen for that — it is a `supabase secrets set`.
- Any signed-in user can look up any other by exact email or phone. That is what
  linking a family needs; it is also enumeration, and it is why item 1 matters.
- Push notifications carry a child's name and status. That is the feature; it
  also means a lost, unlocked phone shows them on the lock screen.

---

## Security testing that should be done

In order of how much they would find, and none of them are expensive.

1. **Query the database as each role, with the app out of the loop.** This is
   the test that matters most, because RLS is the whole defence. Sign in as a
   student and use the Supabase client from a script to `select *` from every
   table; you should get your own rows and nothing else. Repeat as a parent and
   a driver. [`flow-test.sql`](../supabase/patches/flow-test.sql) does part of
   this against a scratch database; it has 46 assertions and should be run
   before every deploy that touches the schema.

2. **Attempt privilege escalation through the API directly.** With a student's
   session token: `update profiles set role = 'admin'`, insert into
   `guardian_links` for somebody else's child, call `set_attendance()` for
   another student, call `mark_attendance()` before noon. Every one should be
   refused by the database with a policy error.

3. **Confirm the bundle is clean.** After every build, `grep` the exported
   JavaScript for `service_role` and `sb_secret_`. The preflight script does
   this on Replit; Render's build should do the same.

4. **Brute-force the sign-in and the portal password.** Supabase rate-limits
   auth endpoints; confirm the limits are on in the dashboard. The portal
   password is compared in constant time but has no attempt counter — that is
   worth adding.

5. **Check `verify.sql` after every patch.** It reads function *bodies*, not
   just names, because a `mark_attendance()` missing its evening lock would pass
   an existence check and let a student mark themselves at breakfast.

6. **Read the audit log for a week of real use.** If overrides are happening
   with reasons like "fix", the reason field is not doing its job.

7. **A dependency audit that separates runtime from build.**
   `npm audit --omit=dev` still reports build tools because Expo lists them as
   dependencies; the honest number is what reaches a device, which today is
   zero. Re-check after any dependency upgrade.

A formal external penetration test is reasonable once real families are on
the system and item 1 above is settled. Before that it would mostly find item 1.

---

## What social sign-in changes, and what it does not

**Changes:** families have no password for this app to forget, reuse, or write
down. Recovery and two-factor become Google's or Apple's, which are better at
both than any school system will be.

**Does not change:** anything above this line. The invite is still required —
a Google account with no invite gets a screen asking for one, and can read
nothing until it is claimed. RLS does not know or care how a session was
created.

**One thing to know:** Apple's App Store requires Sign in with Apple in any iOS
app that offers another provider's sign-in. The button is there; the Apple
Developer configuration behind it is a separate setup step in
[`SETUP.md`](../supabase/SETUP.md).
