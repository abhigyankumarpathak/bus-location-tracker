import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { supabase } from './supabase';

/**
 * The driver's phone as a GPS beacon.
 *
 * This is one of two ways a position reaches `vehicle_locations`; the other is
 * the ingest-location Edge Function, which any hardware tracker can POST to.
 * Neither knows about the other, and the rest of the app reads the table
 * without caring which wrote the row. That is what makes the design survive you
 * finding out later how the real buses are wired.
 *
 * Tracking runs ONLY while a trip is active. A driver is not followed around on
 * their own time, and the app asks for background permission at the moment they
 * start a route rather than at launch.
 */

const LOCATION_TASK = 'bus-tracker-location';

/**
 * The background task runs in a separate JS context with no React state, so the
 * vehicle it is reporting for has to be persisted somewhere it can read. This
 * is the expo-sqlite-backed localStorage that the Supabase client already uses.
 */
const VEHICLE_KEY = 'tracking.vehicle_id';
const TRIP_KEY = 'tracking.trip_id';

interface LocationTaskData {
  locations: Location.LocationObject[];
}

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) return;

  const { locations } = (data ?? {}) as LocationTaskData;
  if (!locations?.length) return;

  const vehicleId = localStorage.getItem(VEHICLE_KEY);
  if (!vehicleId) return;

  const tripId = localStorage.getItem(TRIP_KEY);

  // Only the newest fix matters — we are not backfilling a track log, and
  // sending the whole batch would just be noise on the parents' maps.
  const latest = locations[locations.length - 1];

  await supabase.from('vehicle_locations').insert({
    vehicle_id: vehicleId,
    trip_id: tripId || null,
    lat: latest.coords.latitude,
    lng: latest.coords.longitude,
    heading: latest.coords.heading ?? null,
    speed: latest.coords.speed ?? null,
    source: 'driver_app',
    recorded_at: new Date(latest.timestamp).toISOString(),
  });
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
    timeInterval: 10_000,
    distanceInterval: 25,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Route in progress',
      notificationBody: 'Sharing the van position with students and parents.',
      notificationColor: '#38BDF8',
    },
  });

  return { ok: true };
}

export async function stopTracking() {
  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  localStorage.removeItem(VEHICLE_KEY);
  localStorage.removeItem(TRIP_KEY);
}

export async function isTracking() {
  return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
}

/**
 * A single foreground fix, used when the driver has only granted "While Using"
 * permission. Called on a timer by the driver screen.
 */
export async function reportOnce(vehicleId: string, tripId: string) {
  const { coords } = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.High,
  });

  await supabase.from('vehicle_locations').insert({
    vehicle_id: vehicleId,
    trip_id: tripId,
    lat: coords.latitude,
    lng: coords.longitude,
    heading: coords.heading ?? null,
    speed: coords.speed ?? null,
    source: 'driver_app',
  });
}
