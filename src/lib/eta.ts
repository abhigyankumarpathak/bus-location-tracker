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
