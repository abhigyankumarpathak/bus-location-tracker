/**
 * Vehicle tracking, on WEB — deliberately inert.
 *
 * Same build-time reason as session-storage.web.ts and Map.web.tsx: Metro
 * resolves imports statically, so a runtime `Platform.OS` check cannot keep
 * `expo-task-manager` (which has no web implementation) out of the web bundle.
 * Only a `.web.ts` sibling can.
 *
 * Nothing is lost. A driver runs a route on a phone; the web build exists so a
 * coordinator can work at a desk (§7.3). A browser tab is not a vehicle beacon,
 * and pretending otherwise would put a position on the parents' maps that came
 * from wherever the office laptop happens to be.
 */

export interface StartResult {
  ok: boolean;
  foregroundOnly?: boolean;
  message?: string;
}

/* Signatures mirror tracking.ts exactly, so a caller cannot drift from one to
   the other and only find out in the web build. */

export async function startTracking(
  _vehicleId: string,
  _tripId: string,
): Promise<StartResult> {
  return {
    ok: false,
    message:
      'Live tracking only runs in the phone app. Open the driver app on your phone to share the van position.',
  };
}

export async function stopTracking() {}

export async function isTracking() {
  return false;
}

export async function enforceTrackingScope(_activeTripIds: string[]) {}

export async function reportOnce(_vehicleId: string, _tripId: string) {}
