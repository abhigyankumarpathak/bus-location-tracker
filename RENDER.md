# Deploying on Render

The public build. Render serves the same static export Replit does, on its own
CDN with HTTPS — which is what makes the QR scanner work, since browsers only
expose a camera on a secure origin.

## Setup

1. **New → Static Site**, and connect this repository.
   (Or **New → Blueprint**, which reads [`render.yaml`](render.yaml) and fills in
   everything below for you.)

2. Settings:

   | Field | Value |
   | --- | --- |
   | Build Command | `npm install && npx expo export --platform web` |
   | Publish Directory | `dist` |

3. **Environment** — add both, from Supabase → Project Settings:

   | Key | Where to find it |
   | --- | --- |
   | `EXPO_PUBLIC_SUPABASE_URL` | Data API. The bare project URL, no `/rest/v1`, no trailing slash |
   | `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | API Keys. The **publishable** one |
   | `NODE_VERSION` | `20` |

4. **Redirects/Rewrites** — add one rule:

   | Source | Destination | Action |
   | --- | --- | --- |
   | `/*` | `/index.html` | **Rewrite** |

That last step is not optional, and skipping it produces a bug that looks like
something else entirely. See below.

## The three ways this goes wrong

**No rewrite rule.** expo-router is a single-page app: every screen is a client
route that exists only after the bundle boots. Without the rule Render looks on
disk for a file called `/sign-in`, does not find one, and returns its 404 page.
The symptom is that the homepage works, clicking around works, and then any
**refresh or shared link 404s** — which reads as a broken deploy rather than a
missing redirect.

**Secrets set after the first build.** `EXPO_PUBLIC_*` values are compiled *into*
the bundle by `expo export`, not read at runtime. Add them after a build has run
and that build ships with empty credentials: the deploy succeeds and the site
shows the "Connect Supabase" screen. Set them, then **Manual Deploy → Clear build
cache & deploy**.

**An old Node.** Expo 57 and React Native 0.86 need Node 20 or newer, and the
failure is a wall of module syntax errors that never names the version. Hence
`NODE_VERSION`.

## Checking it worked

Open the site. You should get the sign-in screen — not "Connect Supabase", and
not a 404. Then refresh on any inner page; if that 404s, the rewrite rule is
missing or set to *Redirect* rather than *Rewrite*.

## What Render does that Replit does not

- **HTTPS on a real domain**, so `getUserMedia` is available and **QR scanning
  works in the browser** — Chrome, Safari, Firefox alike.
- **Deploys on push.** Every commit to `main` rebuilds. No Republish button.

## What still has to run somewhere else

**The GPS simulator.** `npm run simulate` is a Node script that POSTs to
Supabase; a static site has no shell and nothing to run it on. Run it from a
laptop, or from a Replit workspace — it reaches Supabase over the internet either
way, and the Render site reads what it writes. The two never talk directly.

**Supabase.** Nothing here deploys the database. Schema patches are pasted into
the Supabase SQL editor, and edge functions go up with `supabase functions
deploy`. Render only ever serves the front end.
