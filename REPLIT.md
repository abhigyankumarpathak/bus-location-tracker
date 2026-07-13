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

## Why Replit serves a static build, not the dev server

There is a hard conflict here, and it is worth understanding before someone
"fixes" it back:

- **Replit's Preview pane and the iPhone "Simulate on Web" frame only watch port
  5000.** Nothing else.
- **Expo's dev server cannot leave port 8081.** The `--port` flag explicitly does
  not apply to web.

Those cannot both be satisfied while Metro is serving. The usual answer is a
reverse proxy, and it is the wrong one.

The right answer is that **Replit does not need a dev server at all.**
`expo export --platform web` produces a plain static site in `dist/`, and static
files can be served on any port you like. So Replit serves the export on 5000 and
Metro never runs there. That also removes the memory pressure — Metro is what was
at risk of being OOM-killed on a small container; serving files is not.

**The tradeoff is hot reload.** A code change needs another Run to rebuild
(a couple of minutes). For showing the app to collaborators — which is what
Replit is for here — that is the right trade.

**If you want live editing on Replit**, run this in the Shell instead:

```sh
npm run replit:dev
```

That runs Metro on 8081 with hot reload. The Preview pane will not see it (wrong
port), so open the `.replit.dev` URL directly in a browser tab.

## Other config notes

**`.replit` must be plain ASCII with no angle brackets.** Replit's TOML parser is
fussy, and — more often — a failed `git pull` leaves `<<<<<<<` conflict markers in
the file, which produces the same misleading parse error pointing at the wrong
line. If you see `expected '.' or '=', but got '<'`, check for a merge conflict
first:

```sh
grep -c '<<<<<<<' .replit
```

**`BROWSER=none`** is set because `expo start --web` tries to open a browser,
which on a Linux container means `xdg-open`, which does not exist — so Expo
crashes before serving anything. Only `replit:dev` needs it.

## If the preview is blank

1. **Wait.** The export is ~1,400 modules and takes a few minutes on a container.
   A build in progress and a broken build look identical from the preview pane.
   Watch the Shell, not the preview.
2. **Port.** `.replit` should have `localPort = 5000`, and the workflow should
   `waitForPort = 5000`.
3. **Run command.** `run = "npm run replit"`.
4. **Secrets.** Missing ones give the "Connect Supabase" screen, not a blank page
   — so blank means something else.
5. **Console.** A failed bundle renders as a white page, and the reason is always
   in the console.
