/**
 * Turn "Corner of Oak Road and Example Way" into a point on a map.
 *
 * The coordinates still exist — a map needs them — but nobody should have to
 * *type* them. An admin setting up a hub knows the street corner, not the
 * latitude, and asking them for 37.3230 / -122.0140 is how you end up with a pin
 * in the ocean.
 *
 * Uses OpenStreetMap's Nominatim: free, no API key, no billing account. That
 * matters for a pilot the blueprint budgets at $0–25/month (§8) — Google's
 * Geocoding API would need a card on file.
 *
 * Their usage policy asks for an identifying User-Agent and no more than one
 * request a second. An admin adding a hub by hand is nowhere near that, but the
 * limiter below makes it true rather than merely likely.
 */

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';

export interface GeocodeResult {
  lat: number;
  lng: number;
  /** What the geocoder thinks it found — always show this before saving. */
  label: string;
}

let lastCall = 0;

/**
 * Rewrite what a human types into what the geocoder understands.
 *
 * This is not cosmetic. A bus stop is almost always a junction, and the natural
 * way to write one is the one thing Nominatim cannot parse. Tested against the
 * live service:
 *
 *   "Corner of Stevens Creek Blvd and Wolfe Road, Cupertino CA"  -> NOT FOUND
 *   "Stevens Creek Blvd and Wolfe Road, Cupertino CA"            -> NOT FOUND
 *   "Stevens Creek Blvd & Wolfe Road, Cupertino CA"              -> the junction
 *
 * So an admin writing the sentence they would naturally write would have been
 * told, wrongly, that their stop does not exist. We rewrite it instead.
 */
function variants(address: string): string[] {
  const raw = address.trim().replace(/\s+/g, ' ');

  // Drop the leading "corner of" / "junction of" / "intersection of".
  const withoutPrefix = raw.replace(/^\s*(corner|junction|intersection)\s+of\s+/i, '');

  // " and " between two streets is an ampersand to a geocoder.
  const ampersand = withoutPrefix.replace(/\s+and\s+/i, ' & ');

  // Last resort: just the first street plus whatever town was given. A pin on
  // the right road beats no pin at all, and the admin can nudge it.
  const [firstStreet, ...rest] = ampersand.split('&');
  const tail = rest.join('&');
  const townMatch = /,(.*)$/.exec(tail || firstStreet);
  const streetOnly = townMatch
    ? `${firstStreet.split(',')[0].trim()},${townMatch[1]}`
    : firstStreet.trim();

  // Deduplicated, in order of how specific they are.
  return [...new Set([ampersand, withoutPrefix, raw, streetOnly])].filter(
    (v) => v.length >= 4,
  );
}

async function lookup(query: string): Promise<GeocodeResult | null> {
  // Nominatim asks for <= 1 request/second. Honour it.
  const wait = 1000 - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();

  const response = await fetch(`${ENDPOINT}?format=json&limit=1&q=${encodeURIComponent(query)}`, {
    headers: {
      // Their policy requires identifying the app. An anonymous script is the
      // thing they block.
      'User-Agent': 'school-transport-app/1.0 (pilot; contact via GitHub)',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Address lookup failed (${response.status}). Check the connection.`);
  }

  const results = (await response.json()) as {
    lat: string;
    lon: string;
    display_name: string;
  }[];

  const hit = results?.[0];
  if (!hit) return null;

  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return { lat, lng, label: hit.display_name };
}

/**
 * Look up an address. Returns null when nothing matches, rather than throwing —
 * "we could not find that" is a normal answer to a typo, not an error.
 *
 * Tries the most specific phrasing first and falls back, so a junction resolves
 * to the junction where possible and to the street otherwise.
 */
export async function geocode(address: string, hint?: string): Promise<GeocodeResult | null> {
  const base = [address.trim(), hint?.trim()].filter(Boolean).join(', ');
  if (base.length < 4) return null;

  for (const query of variants(base)) {
    const hit = await lookup(query);
    if (hit) return hit;
  }
  return null;
}
