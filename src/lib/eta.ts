import type { VehicleLocation } from './types';

/**
 * Straight-line ETA.
 *
 * This is a haversine distance divided by an assumed speed — it does not know
 * about roads, turns, or traffic, so it will under-estimate on a winding route.
 * It is accurate enough to drive the 15- and 5-minute proximity alerts, which
 * is all the README asks of it.
 *
 * If you later want real road ETAs, replace the body of `etaMinutes` with a
 * Directions API call. Nothing else in the app needs to change: every caller
 * goes through this function.
 */

const EARTH_RADIUS_KM = 6371;

/** Assumed average speed when the bus is stopped or not reporting one. */
const FALLBACK_SPEED_KMH = 25;

/** A bus creeping along in traffic shouldn't produce an ETA of three hours. */
const MIN_SPEED_KMH = 8;

export interface Coord {
  lat: number;
  lng: number;
}

export function distanceKm(a: Coord, b: Coord): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Minutes until the vehicle reaches `target`, following the remaining stops in
 * order rather than cutting straight across, so an ETA to stop 5 accounts for
 * the bus still having to visit stops 3 and 4.
 */
export function etaMinutes(
  location: Pick<VehicleLocation, 'lat' | 'lng' | 'speed'> | null,
  target: Coord | null,
  stopsBefore: Coord[] = [],
): number | null {
  if (!location || !target) return null;

  // speed arrives in m/s from expo-location; a negative value means "unknown".
  const reportedKmh = location.speed && location.speed > 0 ? location.speed * 3.6 : 0;
  const speedKmh = Math.max(reportedKmh || FALLBACK_SPEED_KMH, MIN_SPEED_KMH);

  const waypoints = [...stopsBefore, target];

  let km = 0;
  let from: Coord = { lat: location.lat, lng: location.lng };
  for (const point of waypoints) {
    km += distanceKm(from, point);
    from = point;
  }

  // A minute of dwell time per intermediate stop — kids don't board instantly.
  const dwellMinutes = stopsBefore.length;

  return Math.max(0, Math.round((km / speedKmh) * 60 + dwellMinutes));
}

/**
 * The stops the van must still call at before it reaches `targetStopId`, in
 * order — the `stopsBefore` argument to `etaMinutes`.
 *
 * "Still" is the important word: a stop the van has already pulled away from is
 * behind it, and counting that distance again would inflate every ETA down the
 * route. Kept as a pure function of the caller's own lookups so both the parent
 * and student screens get the same answer without either of them owning it.
 */
export function stopsStillToVisit(
  stops: { id: string; seq: number }[],
  targetStopId: string,
  hasDeparted: (stopId: string) => boolean,
  coordsOf: (stopId: string) => Coord | null,
): Coord[] {
  const target = stops.find((s) => s.id === targetStopId);
  if (!target) return [];

  return stops
    .filter((s) => s.seq < target.seq && !hasDeparted(s.id))
    .sort((a, b) => a.seq - b.seq)
    .map((s) => coordsOf(s.id))
    .filter((c): c is Coord => c !== null);
}

export function formatEta(minutes: number | null): string {
  if (minutes === null) return 'No signal from the van yet';
  if (minutes <= 0) return 'Arriving now';
  if (minutes === 1) return '1 minute away';
  if (minutes < 60) return `${minutes} minutes away`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m away` : `${h}h away`;
}

/** The thresholds the README asks for. */
export const ALERT_THRESHOLDS = [15, 5] as const;

/**
 * Which alert (if any) should fire, given the previous ETA and the current one.
 * Fires only on the transition across a threshold, so a bus idling at 4 minutes
 * away doesn't re-notify on every location update.
 */
export function crossedThreshold(previous: number | null, current: number | null): number | null {
  if (current === null || previous === null) return null;
  for (const threshold of ALERT_THRESHOLDS) {
    if (previous > threshold && current <= threshold) return threshold;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Where the van is ALONG the route, not just how far it is from a point.
//
// etaMinutes() answers "how far to the target", and a distance is always
// positive — so once the van drives past a hub it goes on cheerfully reporting
// "12 minutes away" from a stop already behind it. The app's only notion of
// "behind" was `trip_stop_progress.departed_at`, which exists solely because a
// DRIVER tapped Departed. That is the right record of what the operator says
// happened, and it is useless as a description of where the vehicle is: a
// driver who forgets to tap, or a van with no driver app at all, leaves every
// downstream stop believing it is still next.
//
// So this derives it from the position itself. The van is past a stop when its
// projection onto the route's polyline is further along than that stop's.
// ---------------------------------------------------------------------------

/** Metres per degree, near enough at a school district's scale. */
const M_PER_DEG_LAT = 110_574;
const mPerDegLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Project to a local flat plane. Fine over tens of km, and far cheaper. */
function planar(origin: Coord, p: Coord) {
  return {
    x: (p.lng - origin.lng) * mPerDegLng(origin.lat),
    y: (p.lat - origin.lat) * M_PER_DEG_LAT,
  };
}

/**
 * How far along `path` the nearest point to `point` lies, in km.
 *
 * Null when the path is too short to have a direction. Walks every segment
 * rather than snapping to the nearest vertex: on a route with stops kilometres
 * apart, vertex-snapping would report the van as stationary at one hub until it
 * was most of the way to the next.
 */
export function progressAlong(path: Coord[], point: Coord): number | null {
  if (path.length < 2) return null;

  const origin = path[0];
  const P = planar(origin, point);

  let travelled = 0;
  let best: { at: number; distSq: number } | null = null;

  for (let i = 0; i < path.length - 1; i += 1) {
    const A = planar(origin, path[i]);
    const B = planar(origin, path[i + 1]);
    const vx = B.x - A.x;
    const vy = B.y - A.y;
    const segLen = Math.hypot(vx, vy);
    if (segLen === 0) continue;

    // Clamped so a point beyond either end lands on the endpoint, which is what
    // keeps a van that has left the corridor from reporting negative progress.
    const t = Math.min(1, Math.max(0, ((P.x - A.x) * vx + (P.y - A.y) * vy) / (segLen * segLen)));
    const cx = A.x + t * vx;
    const cy = A.y + t * vy;
    const distSq = (P.x - cx) ** 2 + (P.y - cy) ** 2;

    if (!best || distSq < best.distSq) {
      best = { at: (travelled + t * segLen) / 1000, distSq };
    }
    travelled += segLen;
  }

  return best ? best.at : null;
}

/**
 * Has the van already gone past this stop?
 *
 * `route` is the ordered coordinates of every stop on the trip; `target` is the
 * one the family is waiting at. The margin stops a jittering fix from flipping
 * the answer back and forth at the kerb — 150 m is comfortably more than GPS
 * noise and comfortably less than the gap between two hubs.
 */
export function hasPassedStop(
  route: Coord[],
  target: Coord,
  van: Coord,
  marginKm = 0.15,
): boolean {
  const vanAt = progressAlong(route, van);
  const targetAt = progressAlong(route, target);
  if (vanAt === null || targetAt === null) return false;
  return vanAt > targetAt + marginKm;
}

/** Close enough that "minutes away" is the wrong sentence. */
export function isAtStop(van: Coord, target: Coord, radiusKm = 0.12): boolean {
  return distanceKm(van, target) <= radiusKm;
}
