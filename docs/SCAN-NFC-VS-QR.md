# Self-check-in: NFC vs QR

`attendance_mode = 'scan'` ([schema.sql:109](../supabase/schema.sql#L109)) is a switch
with nothing behind it. Here's what it takes to put something behind it, either way.

Day estimates are rough, and assume one developer who knows this codebase.

---

## Both options need the same groundwork

The scan source is a thin layer. This part is the bulk of the job, and it's identical
either way — about **4–6 days**.

- **A per-trip token.** New column on `daily_trips`. Rotation is free, because
  [`ensure_daily_trips`](../supabase/schema.sql#L758) already makes one row per route per
  day. A leaked token dies when the ride ends.

- **A check-in RPC.** `security definer`, so the scanning device never learns the roster
  or gets write access. It checks the trip is active and the student is on it, then
  writes the same patch [`setStatus`](../app/(driver)/trip/%5Bid%5D.tsx#L157-L174) writes
  today.

- **An offline queue.** Buses lose signal, and a scan that never lands is a child marked
  absent while sitting on the van. Queue locally with `expo-sqlite` (already installed)
  and sync on reconnect — which is what forces the RPC to be idempotent.

- **A headcount confirm at depart.** A self-scan can mark a student present on a van
  they're not on. The driver confirms a count where the
  [`boardedHere` sweep](../app/(driver)/trip/%5Bid%5D.tsx#L147-L152) already runs.

- **The manual override stays.** Dead battery, forgotten card, six-year-old.

- **RLS, grants, and the admin toggle** at [setup.tsx:1324](../app/(staff)/setup.tsx#L1324).

One thing worth knowing: scanning only ever produces positive events. Nobody taps to say
"I'm not here", so `no_show` stays inferred at depart.

---

## QR

Extra effort on top of the groundwork: **half a day to a day.**

### Pros

- Zero new dependencies. `react-native-qrcode-svg` and `expo-camera` are already installed.
- The camera permission is already written — [app.json:47](../app.json#L47) says
  *"Bus Tracker uses the camera to scan student check-in QR codes."*
- Works on web, which we ship (`npm run replit` exports and serves `dist`). One code path.
- No native rebuild, no config plugin, no dev-client cycle.
- Validation is one `hmac()` call in plain SQL. pgcrypto is available —
  [schema.sql:217](../supabase/schema.sql#L217) already uses `gen_random_bytes`.
- No hardware to buy, program, ship, lose, or replace.
- Testable in a simulator and on web, without touching a bus.
- Cheap to reverse if the pilot goes badly.

### Cons

- Everyone scans the same code, so one photo of the driver's screen works for anyone
  until it rotates. A shorter window means more cheating protection but more failed scans.
- Slower boarding — thirty kids unlocking phones, in the rain.
- Needs line of sight to the driver's screen, awkward on a full van.
- Rotation must use server time only. Don't trust device clocks.

---

## NFC

Extra effort: **8–12 days**, plus procurement and ops time that isn't coding at all.

### Pros

- **Replay is genuinely dead.** NTAG 424 DNA (~£1/tag) signs every tap with an
  incrementing counter, using an on-tag crypto engine powered by the reader's field. Each
  payload is single-use, so faking five friends means tapping five times at the door.
  This is the one place NFC really beats QR.
- Faster boarding. A tap is about a second and needs no unlock.
- No line of sight. Works in the dark.
- In the tag-on-bus model, identity comes from the student's session — stronger than a
  cloneable card UID.

### Cons

- **Impossible on web.** NFC doesn't exist in browsers, so our web build needs a
  manual-only fallback maintained forever. That's an ongoing tax, not a line item.
- New native module (`react-native-nfc-manager`), a config plugin, and a dev-client
  rebuild. Every build gets slower.
- Apple wants an entitlement, an `Info.plist` string, and the NFC capability on the
  provisioning profile — a Developer portal task, not a commit.
- Android needs `android.permission.NFC` and intent filters.
- **Cheap tags are unusable.** A static NTAG 213 says the same thing forever: read once,
  replay forever. A peeled-off sticker becomes an infinite check-in machine.
- **Validation can't live in Postgres.** pgcrypto has `hmac()` but no AES-CMAC, so this
  needs an Edge Function hand-rolling CMAC over AES-CBC, plus master-key storage and
  per-tag key diversification.
- Tags ship keyless, so someone writes a provisioning script and programs every tag
  before it goes on a van. That's a new ops process we've never run.
- No simulator. Physical device and physical tags for every test.
- If we go card-per-student instead, add a credentials table, an issuance screen, and a
  lost/replace/deactivate flow.

---

## Effort

| | Groundwork | Extra | Total | New deps | Web | Hardware |
| --- | --- | --- | --- | --- | --- | --- |
| **QR** | 4–6 d | 0.5–1 d | **5–7 d** | none | yes | none |
| **NFC** | 4–6 d | 8–12 d | **12–18 d** + ops | native module, Edge Function, Apple capability | never | tags + provisioning |

The totals matter less than the split. The groundwork is the same either way, so the real
decision is one day versus eight to twelve.

---

## Recommendation

Build QR. Same feature, uses what's already installed, and runs on web — which NFC never
will. The scan source is a thin layer over the groundwork above, so if cheating turns out
to be a real problem in the pilot, we swap that layer for NTAG 424 and nothing else moves.

One caveat matters more than the technology: **self-scan only covers students who have a
phone.** If a meaningful share of riders don't, neither option is an attendance system on
its own, and the driver's manual roster stays primary. Worth settling before funding
either.
