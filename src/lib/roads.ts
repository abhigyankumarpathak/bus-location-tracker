import { useEffect, useState } from 'react';
import type { Coord } from './eta';

/**
 * The route line, along actual roads.
 *
 * `Map` draws whatever ordered points it is handed, and it was handed the stops
 * themselves — so the blue line ran hub to hub in straight segments, through
 * back gardens and across the Christina River, while the van it was supposed to
 * describe drove round by the road. On a map that is not a rough edge; it is the
 * one element a parent reads as "this is where the bus goes".
 *
 * OSRM's public demo server returns real driving geometry for free, with no API
 * key and no billing account — the same reasoning that put Nominatim behind the
 * address lookup in ./geocode. It sends `access-control-allow-origin: *`, so the
 * web build can call it directly rather than needing a proxy.
 *
 * DELIBERATELY NOT A HARD DEPENDENCY. It is a demo server with no uptime
 * promise, and a map with a slightly wrong line beats a map with no line at all
 * — so every failure path returns the straight stop-to-stop path instead, and
 * the caller cannot tell the difference beyond the shape.
 *
 * There is a second copy of this logic in scripts/simulate.mjs. That is
 * deliberate and matches ./geocode: this file is TypeScript inside the Expo
 * bundle, that one is a plain Node script, and porting twenty lines beats a
 * build step.
 */

const OSRM = 'https://router.project-osrm.org/route/v1/driving';

/** Keyed on the coordinates themselves — `stops` is a fresh array every render. */
const keyOf = (stops: Coord[]) =>
  stops.map((s) => `${s.lat.toFixed(5)},${s.lng.toFixed(5)}`).join(';');

/** Roads do not move between renders, or between one parent and the next. */
const cache = new Map<string, Coord[]>();
/** Two screens mounting at once must not both ask a shared demo server. */
const inflight = new Map<string, Promise<Coord[] | null>>();

async function fetchRoad(stops: Coord[]): Promise<Coord[] | null> {
  const pairs = stops.map((s) => `${s.lng},${s.lat}`).join(';');

  try {
    const res = await fetch(`${OSRM}/${pairs}?overview=full&geometries=geojson`);
    if (!res.ok) return null;

    const body = (await res.json()) as {
      code?: string;
      routes?: { geometry?: { coordinates?: [number, number][] } }[];
    };
    if (body.code !== 'Ok') return null;

    const coords = body.routes?.[0]?.geometry?.coordinates;
    if (!coords?.length) return null;

    return coords.map(([lng, lat]) => ({ lat, lng }));
  } catch {
    // Offline, blocked, or the demo server having a day. Not worth a banner:
    // the straight line still describes the route's shape well enough to read.
    return null;
  }
}

/**
 * Road geometry through `stops`, in order.
 *
 * Returns the straight stop-to-stop path immediately and swaps in the road one
 * when it arrives, so the map never renders empty and never blocks on a network
 * call it does not need to complete.
 */
export function useRoadPath(stops: Coord[]): Coord[] {
  const key = keyOf(stops);
  const [road, setRoad] = useState<Coord[] | null>(() => cache.get(key) ?? null);

  useEffect(() => {
    // OSRM needs at least an origin and a destination to have a road between.
    if (stops.length < 2) {
      setRoad(null);
      return;
    }

    const cached = cache.get(key);
    if (cached) {
      setRoad(cached);
      return;
    }

    let cancelled = false;

    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchRoad(stops).then((result) => {
        if (result) cache.set(key, result);
        inflight.delete(key);
        return result;
      });
      inflight.set(key, pending);
    }

    pending.then((result) => {
      if (!cancelled) setRoad(result);
    });

    return () => {
      cancelled = true;
    };
    // `key` is the identity of `stops`; the array itself changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return road ?? stops;
}
