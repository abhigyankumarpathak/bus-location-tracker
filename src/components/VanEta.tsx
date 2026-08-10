import { StyleSheet, Text, View } from 'react-native';
import { etaMinutes, formatEta } from '../lib/eta';
import type { Coord } from '../lib/eta';
import type { VehicleLocation } from '../lib/types';
import { Map } from './Map';
import type { MapMarker } from './Map';
import { theme } from './ui';

/**
 * "The van is 6 minutes away", when live tracking is on.
 *
 * The honest counterpart to the scheduled alerts in lib/alerts.ts. Those say the
 * van is DUE in 15 minutes off the timetable, which stays true-sounding when the
 * van is half an hour late. This one is derived from where the van actually is,
 * so it is the only place in the app that can say "away" rather than "due".
 *
 * Renders nothing at all when tracking is off or the van has not reported —
 * callers show their planned-times panel instead. A silent absence is right here:
 * an ETA of "unknown" is worse than no ETA, because a family will read it as a
 * problem with the van rather than with the feature.
 */

interface Props {
  location: VehicleLocation | null;
  /** True when the last fix is too old to present as live. */
  stale: boolean;
  /** Where the family is waiting — their hub. */
  target: Coord | null;
  hubName: string;
  /** Stops the van must still call at first, from lib/eta stopsStillToVisit(). */
  stopsBefore?: Coord[];
  /** Draw a small map with the van and the hub on it. */
  showMap?: boolean;
}

export function VanEta({
  location,
  stale,
  target,
  hubName,
  stopsBefore = [],
  showMap = false,
}: Props) {
  if (!location || !target) return null;

  if (stale) {
    const since = new Date(location.recorded_at).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
    return (
      <View style={styles.wrap}>
        <Text style={styles.stale}>
          🛰️ The van last reported at {since} and has gone quiet since — it may be somewhere with no
          signal. Planned times below are the best guide until it reports again.
        </Text>
      </View>
    );
  }

  const minutes = etaMinutes(location, target, stopsBefore);

  const markers: MapMarker[] = [
    { id: 'van', lat: location.lat, lng: location.lng, title: 'The van', kind: 'bus' },
    { id: 'hub', lat: target.lat, lng: target.lng, title: hubName, kind: 'pickup' },
  ];

  return (
    <View style={styles.wrap}>
      <Text style={styles.eta}>
        🚌 {formatEta(minutes)}
        {minutes !== null && minutes > 0 ? ` from ${hubName}` : ''}
      </Text>
      {stopsBefore.length > 0 ? (
        <Text style={styles.fine}>
          {stopsBefore.length} {stopsBefore.length === 1 ? 'stop' : 'stops'} to go first.
        </Text>
      ) : null}
      <Text style={styles.fine}>
        Straight-line estimate from the van's own position, not a road route — treat it as
        approximate.
      </Text>

      {showMap ? (
        <Map
          markers={markers}
          center={{ lat: location.lat, lng: location.lng }}
          zoom={14}
          style={styles.map}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  eta: { fontSize: 15, fontWeight: '700', color: theme.accent, lineHeight: 21 },
  stale: { fontSize: 13, color: theme.warn, lineHeight: 19 },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  map: { height: 200, borderRadius: 12, marginTop: 6 },
});
