# Running this on Replit

[![Run on Replit](https://replit.com/badge/github/abhigyankumarpathak/bus-location-tracker)](https://replit.com/new/github/abhigyankumarpathak/bus-location-tracker)

The fastest way for a collaborator to see the app without installing anything.

## Setup

1. Click the badge. Replit forks the repo and installs the dependencies.
2. Open the **Secrets** tab (the padlock in the left sidebar) and add:

   | Secret | Where to find it |
   | --- | --- |
   | `EXPO_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → Data API |
   | `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase → Project Settings → API Keys |

3. Press **Run**.

Without the secrets the app still starts — you get a "Connect Supabase" screen
rather than a crash, and the console prints exactly what is missing and where to
get it.

**The URL must be the bare project URL** — `https://yourref.supabase.co`, with no
`/rest/v1` and no trailing slash. The client appends the path itself. The
preflight script catches this, because it produces a baffling runtime error
otherwise.

## Share the publishable key freely. Never the secret one.

The **publishable** (anon) key is meant to ship in the app. It grants nothing on
its own: Row Level Security decides what each signed-in user can read, and
Postgres enforces that regardless of who holds the key.

The **secret / service_role** key bypasses RLS entirely. Anything in an
`EXPO_PUBLIC_*` variable is compiled into the page every visitor downloads, so
putting it here would hand every visitor a key to the whole database. The
preflight script refuses to start if it sees one.

## Replit runs the web build only

It is a Linux container, so there is no iOS or Android simulator on it, and no
command that would put one there. Expo Go cannot help either — this app uses
native modules (camera, location, maps) that Expo Go does not contain.

That is not a cut-down version. Every role, screen, and rule is present. The only
thing missing is **push notifications**, because browsers have no
`expo-notifications` — alerts still land in the in-app inbox.

A browser is also where a transport coordinator actually belongs (the MVP
blueprint asked for exactly this in §7.3), so the web build is the *right* target
for the people most likely to be reviewing the work.

## Notes on the config

**`.replit` must be plain ASCII with no angle brackets.** Replit's TOML parser
rejected the file when the comments contained em-dashes, emoji, and a
`<project-ref>` placeholder — with a misleading error pointing at the wrong line.
That is why the explanation lives in this file instead.

**Port 8081, not 5000.** Expo's web dev server is fixed to 8081 — the `--port`
flag explicitly does not apply to web. `.replit` forwards 8081 to the preview. If
something rewrites the run command or the port mapping, the preview goes blank.

**Metro is capped at two workers** (`--max-workers 2` in the `replit` script) and
Node's heap is raised. Metro spawns a worker per CPU core by default and each is
hungry; on a small container that gets the bundler OOM-killed partway through an
1,800-module build, which looks exactly like the app hanging on a spinner.

## If the preview is blank

1. **Check the console.** A failed bundle renders as a white page, and the reason
   is always in the console.
2. **Port.** `.replit` should have `localPort = 8081`.
3. **Run command.** It should be `run = "npm run replit"`.
4. **Secrets.** Missing ones give the setup screen, not a blank page — so a blank
   page means something else.
