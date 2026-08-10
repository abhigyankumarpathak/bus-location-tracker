import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { supabase } from './supabase';

/**
 * The driver's phone as a GPS beacon.
 *
 * This is one of two ways a position reaches `vehicle_locations`; the other is
 * the ingest-location Edge Function, which any hardware tracker can POST to.
 * Neither knows about the other, and the rest of the app reads the table without
 * caring which wrote the row. That is what makes the design survive you finding
 * out later how the real buses are wired.
 *
 * ---------------------------------------------------------------------------
 * THE RULE: a driver is followed while they are driving a route, and never
 * otherwise. Not before, not after, not on their own time.
 * ---------------------------------------------------------------------------
 *
 * That is not one check, because one check is not enough — a driver who forgets
 * to tap "End trip" and drives home must not be tracked all the way there. Four
 * independent things have to fail before that can happen:
 *
 *  1. START is tied to the trip. Nothing calls startTracking() except starting a
 *     trip, or reopening the screen of a trip that is already running. The
 *     permission prompt happens at that moment, not at app launch.
 *
 *  2. STOP is tied to the trip. Ending a trip stops the sensor. Opening the
 *     driver's home screen calls enforceTrackingScope(), which stops a task left
 *     running for a trip that is no longer active — so simply opening the app
 *     cleans up after a forgotten "End trip".
 *
 *  3. THE TASK STOPS ITSELF. It checks the clock against MAX_ROUTE_MS, and it
 *     treats the database refusing a row as authoritative: the RLS policy on
 *     vehicle_locations only accepts positions for a trip that is `active`, so a
 *     rejected insert means the route is over and the task shuts itself down. The
 *     phone stops reporting even if the app is never opened again.
 *
 *  4. THE DATABASE IS THE BACKSTOP. Even if all of the above were bypassed, no
 *     position can be stored outside an active trip the caller is driving.
 *
 * A PARKED VAN GOES QUIET. Idling at a stop or sitting at the depot mid-route
 * should not produce a fix every ten seconds: it is a battery cost, a storage
 * cost, and a privacy cost for nothing, since the answer has not changed. The
 * task reports on MOVEMENT, plus a slow heartbeat so "the van is stationary" stays
 * distinguishable from "the phone has lost signal" — a distinction the parent
 * screens draw, so it has to be real.
 */

const LOCATION_TASK = 'bus-tracker-location';

/**
 * The background task runs in a separate JS context with no React state, so the
 * vehicle it is reporting for has to be persisted somewhere it can read. This is
 * the expo-sqlite-backed localStorage that the Supabase client already uses.
 */
const VEHICLE_KEY = 'tracking.vehicle_id';
const TRIP_KEY = 'tracking.trip_id';
const STARTED_KEY = 'tracking.started_at';
const LAST_FIX_KEY = 'tracking.last_fix';

/**
 * No school route runs six hours. Past that, the overwhelmingly likely
 * explanation is a driver who never tapped "End trip", so the task stops itself
 * rather than following them into the evening.
 */
const MAX_ROUTE_MS = 6 * 60 * 60 * 1000;

/** Report when the van has moved this far since the last stored position. */
const MIN_MOVE_METRES = 30;

/**
 * ...or this long, whichever comes first. A stationary van still says "I am here
 * and my phone is alive" every ninety seconds, which is what lets the parent
 * screens tell parked from lost. Keep this comfortably below the staleness
 * threshold in useVehicleLocation, or a parked van reads as a missing one.
 */
const HEARTBEAT_MS = 90_000;

/** PostgREST surfaces an RLS refusal as Postgres 42501, insufficient_privilege. */
const RLS_REFUSED = '42501';

interface LocationTaskData {
  locations: Location.LocationObject[];
}

interface StoredFix {
  lat: number;
  lng: number;
  at: number;
}

/** Metres between two coordinates. Local helper so the task pulls in nothing. */
function metresBetween(a: StoredFix, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
  return 2 * R * Math.asin(Math.sqrt(h));
}

function readLastFix(): StoredFix | null {
  const raw = localStorage.getItem(LAST_FIX_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredFix;
    return typeof parsed?.lat === 'number' && typeof parsed?.lng === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Is this fix worth storing? Movement, or the heartbeat falling due. Everything
 * else is the same answer written down again.
 */
function worthReporting(next: { lat: number; lng: number }, now: number): boolean {
  const last = readLastFix();
  if (!last) return true;
  if (now - last.at >= HEARTBEAT_MS) return true;
  return metresBetween(last, next) >= MIN_MOVE_METRES;
}

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) return;

  const { locations } = (data ?? {}) as LocationTaskData;
  if (!locations?.length) return;

  const vehicleId = localStorage.getItem(VEHICLE_KEY);
  const tripId = localStorage.getItem(TRIP_KEY);

  // Nothing to report for. Should not happen, but a task with no trip is exactly
  // the runaway case this guards, so treat it as one.
  if (!vehicleId || !tripId) {
    await stopTracking();
    return;
  }

  // Guard 3a: the clock. A route that has been "running" for six hours is not
  // running.
  const startedAt = Number(localStorage.getItem(STARTED_KEY) ?? 0);
  if (startedAt && Date.now() - startedAt > MAX_ROUTE_MS) {
    await stopTracking();
    return;
  }

  // Only the newest fix matters — we are not backfilling a track log, and
  // sending the whole batch would just be noise on the parents' maps.
  const latest = locations[locations.length - 1];
  const next = { lat: latest.coords.latitude, lng: latest.coords.longitude };
  const now = Date.now();

  if (!worthReporting(next, now)) return;

  const { error: insertError } = await supabase.from('vehicle_locations').insert({
    vehicle_id: vehicleId,
    trip_id: tripId,
    lat: next.lat,
    lng: next.lng,
    heading: latest.coords.heading ?? null,
    speed: latest.coords.speed ?? null,
    source: 'driver_app',
    recorded_at: new Date(latest.timestamp).toISOString(),
  });

  // Guard 3b: the database is the authority on whether the route is still on.
  // Its policy accepts a position only for an ACTIVE trip driven by this user, so
  // a refusal means the trip has ended (or been reassigned) and this phone has
  // no business reporting any more. Stop the sensor, not just this write.
  //
  // Only on a refusal. A dropped connection means try again in thirty seconds —
  // going quiet in a tunnel would be the opposite of what anyone wants.
  if (insertError) {
    if (insertError.code === RLS_REFUSED) await stopTracking();
    return;
  }

  localStorage.setItem(LAST_FIX_KEY, JSON.stringify({ ...next, at: now }));
});

export interface StartResult {
  ok: boolean;
  /** True when only foreground permission was granted. */
  foregroundOnly?: boolean;
  message?: string;
}

export async function startTracking(vehicleId: string, tripId: string): Promise<StartResult> {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (foreground.status !== 'granted') {
    return {
      ok: false,
      message:
        'Location permission is required to run a route — the students and parents cannot see the van without it.',
    };
  }

  localStorage.setItem(VEHICLE_KEY, vehicleId);
  localStorage.setItem(TRIP_KEY, tripId);
  localStorage.setItem(STARTED_KEY, String(Date.now()));
  // A fresh route starts with no history, so the first fix always reports.
  localStorage.removeItem(LAST_FIX_KEY);

  const background = await Location.requestBackgroundPermissionsAsync();

  if (background.status !== 'granted') {
    // Degrade rather than refuse: the driver can still run the route, the van
    // just stops reporting if they switch apps. Say so plainly instead of
    // failing silently, which would look like a broken map to every parent.
    return {
      ok: true,
      foregroundOnly: true,
      message:
        'The van will only report its position while this screen is open. Allow "Always" location to keep tracking when you switch apps.',
    };
  }

  const already = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
  if (already) return { ok: true };

  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    // Movement is the trigger; the interval is the ceiling on how often we even
    // look. Ten seconds was a fix every ten seconds from a van sitting still.
    timeInterval: 30_000,
    distanceInterval: MIN_MOVE_METRES,
    // Let iOS shut the radio down when the van is not going anywhere, and tell it
    // what kind of movement to expect so it does that well. The old `false` here
    // was explicitly opting out of the platform's own stationary detection.
    pausesUpdatesAutomatically: true,
    activityType: Location.ActivityType.AutomotiveNavigation,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Route in progress',
      notificationBody: 'Sharing the van position with students and parents. Stops when you end the trip.',
      notificationColor: '#38BDF8',
    },
  });

  return { ok: true };
}

export async function stopTracking() {
  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(() => {});
  localStorage.removeItem(VEHICLE_KEY);
  localStorage.removeItem(TRIP_KEY);
  localStorage.removeItem(STARTED_KEY);
  localStorage.removeItem(LAST_FIX_KEY);
}

export async function isTracking() {
  return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
}

/**
 * Guard 2: stop a task that is running for a trip which is no longer active.
 *
 * Called wherever the driver app learns the true set of running trips — its home
 * screen. That makes "open the app" a cleanup for a forgotten "End trip", which
 * matters because opening the app is the one thing a driver reliably does the
 * next morning.
 *
 * Passing an empty list means "no route is running", and stops tracking.
 */
export async function enforceTrackingScope(activeTripIds: string[]) {
  if (!(await isTracking())) return;

  const tripId = localStorage.getItem(TRIP_KEY);
  if (!tripId || !activeTripIds.includes(tripId)) await stopTracking();
}

/**
 * A single foreground fix, used when the driver has only granted "While Using"
 * permission. Called on a timer by the driver screen, which only runs it while a
 * trip is active — so the same rule holds: no route, no position.
 *
 * Skips the write when the van has not moved, for the same reason the background
 * task does.
 */
export async function reportOnce(vehicleId: string, tripId: string) {
  const { coords } = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.High,
  });

  const next = { lat: coords.latitude, lng: coords.longitude };
  const now = Date.now();
  if (!worthReporting(next, now)) return;

  const { error } = await supabase.from('vehicle_locations').insert({
    vehicle_id: vehicleId,
    trip_id: tripId,
    lat: next.lat,
    lng: next.lng,
    heading: coords.heading ?? null,
    speed: coords.speed ?? null,
    source: 'driver_app',
  });

  if (error) throw error;
  localStorage.setItem(LAST_FIX_KEY, JSON.stringify({ ...next, at: now }));
}
