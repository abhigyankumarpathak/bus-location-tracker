/**
 * Drive a fake bus along a route, so everything downstream of a GPS fix can be
 * tested without a vehicle, a tracker, or leaving the desk.
 *
 * It is a tracker, not a shortcut. It POSTs to the same `ingest-location`
 * endpoint real hardware will use, with the same payload and the same
 * device_key credential, so nothing between here and the parent's map knows the
 * difference — which is the only way this proves anything.
 *
 *   npm run simulate -- --bus "Van 1" --speed 40 --dwell 25 --loop
 *   npm run simulate -- --key <device_key> --route scripts/routes/wilmington-de.json
 *   npm run simulate -- --key <device_key> --dry-run
 *
 * WAYPOINTS CAN BE ADDRESSES. A route file may carry `{"address": "..."}`
 * instead of coordinates; they are geocoded once, printed with whatever the
 * geocoder thinks it matched, and written back into the file so the next run is
 * offline and so a human can correct a bad pin. Nobody should be hand-typing
 * latitudes — that is how you get a bus in the Atlantic.
 */

import { readFileSync, writeFileSync } from 'node:fs';

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const opts = {
  key: flag('key'),
  bus: flag('bus'),
  route: flag('route', 'scripts/routes/wilmington-de.json'),
  speed: Number(flag('speed', 40)),      // km/h
  dwell: Number(flag('dwell', 20)),      // seconds at a named stop
  interval: Number(flag('interval', 5)), // seconds between fixes
  loop: has('loop'),
  reverse: has('reverse'),
  dryRun: has('dry-run'),
};

if (has('help') || (!opts.key && !opts.bus && !opts.dryRun)) {
  console.log(`
Drive a fake bus along a route.

  --key <device_key>   The vehicle's device_key. Get it from Setup → Fleet,
                       or:  select device_key from vehicle_devices;
  --bus  "<label>"     Look the key up by vehicle label instead. Needs
                       SUPABASE_SERVICE_ROLE_KEY in the environment.
  --route <file>       Default: scripts/routes/wilmington-de.json
  --speed <km/h>       Default: 40
  --dwell <seconds>    Pause at each named stop. Default: 20
  --interval <sec>     Seconds between fixes. Default: 5
  --loop               Run the route over and over.
  --reverse            Drive it backwards (the afternoon run).
  --dry-run            Print fixes instead of POSTing them.
`);
  process.exit(has('help') ? 0 : 1);
}

// ---------------------------------------------------------------- environment

/** Expo reads .env; Node does not. Same helper as scripts/replit-preflight.mjs. */
function fromEnvFile(name) {
  try {
    const line = readFileSync('.env', 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith(`${name}=`));
    return line?.slice(line.indexOf('=') + 1).trim() || undefined;
  } catch {
    return undefined;
  }
}

const SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL ?? fromEnvFile('EXPO_PUBLIC_SUPABASE_URL');
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? fromEnvFile('SUPABASE_SERVICE_ROLE_KEY');

if (!SUPABASE_URL && !opts.dryRun) {
  console.error('EXPO_PUBLIC_SUPABASE_URL is not set. Add it to .env or Replit Secrets.');
  process.exit(1);
}

// ---------------------------------------------------------------- geocoding

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
let lastGeocode = 0;

/**
 * Same service, policy and User-Agent rule as src/lib/geocode.ts. Kept separate
 * rather than imported because that file is TypeScript inside the Expo bundle
 * and this is a plain Node script — porting nine lines beats a build step.
 */
async function geocode(address) {
  const wait = 1000 - (Date.now() - lastGeocode);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocode = Date.now();

  const res = await fetch(`${ENDPOINT}?format=json&limit=1&q=${encodeURIComponent(address)}`, {
    headers: {
      'User-Agent': 'school-transport-app/1.0 (route simulator; contact via GitHub)',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Geocoder returned ${res.status} for "${address}"`);

  const hit = (await res.json())?.[0];
  if (!hit) return null;
  return { lat: Number(hit.lat), lng: Number(hit.lon), label: hit.display_name };
}

/** Resolve any address-only waypoints, then write the coordinates back. */
async function resolveRoute(file) {
  const points = JSON.parse(readFileSync(file, 'utf8'));
  let changed = false;

  for (const p of points) {
    if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) continue;
    if (!p.address) throw new Error(`Waypoint needs lat/lng or address: ${JSON.stringify(p)}`);

    process.stdout.write(`  geocoding ${p.name ?? p.address} … `);
    const hit = await geocode(p.address);
    if (!hit) {
      console.log('NOT FOUND');
      throw new Error(
        `Could not geocode "${p.address}". Fix the address, or put lat/lng in ${file} by hand.`,
      );
    }
    p.lat = hit.lat;
    p.lng = hit.lng;
    p.resolved = hit.label;
    changed = true;
    console.log(`${hit.lat.toFixed(5)}, ${hit.lng.toFixed(5)}`);
    console.log(`      ↳ ${hit.label}`);
  }

  if (changed) {
    // Written back so the next run needs no network, and — more importantly —
    // so a human can SEE what was matched and correct it. A geocoder will
    // happily return the right street in the wrong county.
    writeFileSync(file, `${JSON.stringify(points, null, 2)}\n`);
    console.log(`\n  Coordinates written back to ${file}.`);
    console.log('  Check the ↳ lines above before trusting the run.\n');
  }

  return points;
}

// ---------------------------------------------------------------- geometry

const R = 6371000; // metres
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

function distance(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearing(a, b) {
  const dLng = rad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Straight-line interpolation. A bus follows roads; this does not, and that is
 *  fine — everything downstream cares about a moving point, not the shape of it. */
const between = (a, b, t) => ({
  lat: a.lat + (b.lat - a.lat) * t,
  lng: a.lng + (b.lng - a.lng) * t,
});

// ---------------------------------------------------------------- reporting

async function deviceKeyForBus(label) {
  if (!SERVICE_KEY) {
    console.error(
      `--bus needs SUPABASE_SERVICE_ROLE_KEY in the environment (vehicle_devices is admin-only).\n` +
        `Either set it — WITHOUT an EXPO_PUBLIC_ prefix, it must never reach the browser bundle —\n` +
        `or pass --key <device_key> directly.`,
    );
    process.exit(1);
  }

  const q = `${SUPABASE_URL}/rest/v1/vehicles?label=eq.${encodeURIComponent(label)}&select=id,label`;
  const res = await fetch(q, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const vehicles = await res.json();
  if (!Array.isArray(vehicles) || !vehicles.length) {
    console.error(`No vehicle labelled "${label}". Check Setup → Fleet.`);
    process.exit(1);
  }

  const dq = `${SUPABASE_URL}/rest/v1/vehicle_devices?vehicle_id=eq.${vehicles[0].id}&select=device_key`;
  const dres = await fetch(dq, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const devices = await dres.json();
  if (!Array.isArray(devices) || !devices.length) {
    console.error(`"${label}" has no device row. That should be impossible — check the schema.`);
    process.exit(1);
  }
  return devices[0].device_key;
}

let sent = 0;
let failed = 0;

async function report(deviceKey, fix) {
  const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const line =
    `  ${stamp}  ${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}` +
    `  ${String(Math.round(fix.heading)).padStart(3)}°` +
    `  ${(fix.speed * 3.6).toFixed(0)} km/h`;

  if (opts.dryRun) {
    console.log(`${line}   (dry run)`);
    return;
  }

  try {
    // verify_jwt = false for this function (supabase/config.toml) — the
    // device_key IS the credential, exactly as it will be for real hardware.
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ingest-location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_key: deviceKey,
        lat: fix.lat,
        lng: fix.lng,
        heading: Math.round(fix.heading),
        speed: Number(fix.speed.toFixed(1)),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      failed += 1;
      console.log(`${line}   ✗ ${res.status} ${body.error ?? ''}`);
      return;
    }
    sent += 1;
    console.log(`${line}   ✓${body.trip_id ? ' trip' : ''}`);
  } catch (e) {
    failed += 1;
    console.log(`${line}   ✗ ${e.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the run

async function drive(deviceKey, points) {
  const mps = (opts.speed * 1000) / 3600;
  const stepMetres = mps * opts.interval;

  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i];
    const to = points[i + 1];
    const legMetres = distance(from, to);
    const heading = bearing(from, to);
    const steps = Math.max(1, Math.ceil(legMetres / stepMetres));

    console.log(
      `\n▸ ${from.name ?? `waypoint ${i + 1}`} → ${to.name ?? `waypoint ${i + 2}`}` +
        `   ${(legMetres / 1000).toFixed(2)} km, ~${Math.round((legMetres / mps) / 60)} min`,
    );

    for (let s = 1; s <= steps; s += 1) {
      const at = between(from, to, s / steps);
      await report(deviceKey, { ...at, heading, speed: mps });
      await sleep(opts.interval * 1000);
    }

    // Sit at the stop. A real bus does, and it is the case that separates
    // "parked" from "signal lost" downstream — so the fixes keep coming.
    const dwell = to.name ? (to.dwell ?? opts.dwell) : 0;
    if (dwell > 0) {
      console.log(`  … dwelling ${dwell}s at ${to.name}`);
      const ticks = Math.max(1, Math.round(dwell / opts.interval));
      for (let t = 0; t < ticks; t += 1) {
        await report(deviceKey, { ...to, heading, speed: 0 });
        await sleep(opts.interval * 1000);
      }
    }
  }
}

// ---------------------------------------------------------------- main

const deviceKey = opts.key ?? (opts.bus ? await deviceKeyForBus(opts.bus) : 'DRY-RUN');

console.log(`\nRoute: ${opts.route}`);
let points = await resolveRoute(opts.route);
if (opts.reverse) points = [...points].reverse();

console.log(
  `${points.length} waypoints · ${opts.speed} km/h · fix every ${opts.interval}s` +
    `${opts.loop ? ' · looping' : ''}${opts.dryRun ? ' · DRY RUN' : ''}`,
);
console.log(`Posting to ${opts.dryRun ? '(nowhere)' : `${SUPABASE_URL}/functions/v1/ingest-location`}`);

process.on('SIGINT', () => {
  console.log(`\n\nStopped. ${sent} fixes accepted, ${failed} failed.\n`);
  process.exit(0);
});

do {
  await drive(deviceKey, points);
  if (opts.loop) console.log('\n↻ Route complete — going round again. Ctrl-C to stop.');
} while (opts.loop);

console.log(`\nDone. ${sent} fixes accepted, ${failed} failed.\n`);
