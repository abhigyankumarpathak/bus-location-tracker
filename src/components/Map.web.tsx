import { StyleSheet, Text, View } from 'react-native';
import { theme } from './ui';

/**
 * The map, on WEB.
 *
 * `expo-maps` has no web implementation at all. The native Map.tsx imports it at
 * the top of the file, and on web that import blows up the moment the screen
 * mounts — which renders as a blank white page, because the component never gets
 * far enough to show its own fallback.
 *
 * Metro resolves this `.web.tsx` first when bundling for web, so `expo-maps` is
 * never referenced there. Same reason session-storage.web.ts exists. A runtime
 * `Platform.OS` check does NOT work: Metro resolves imports at build time.
 *
 * Rather than a dead grey box, this draws the route as an ordered line of stops.
 * A parent on a laptop wants to know which corner and in what order — which the
 * list underneath already gives them in full — so this is a diagram, not a
 * degraded map.
 */

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  title: string;
  kind?: 'bus' | 'stop' | 'pickup';
}

interface MapProps {
  markers: MapMarker[];
  path?: { lat: number; lng: number }[];
  center?: { lat: number; lng: number } | null;
  zoom?: number;
  style?: object;
}

export function Map({ markers, style }: MapProps) {
  if (markers.length === 0) {
    return (
      <View style={[styles.panel, style]}>
        <Text style={styles.muted}>No stops to show yet.</Text>
      </View>
    );
  }

  // Buses only ever appear when live tracking is on; on web they would have no
  // position anyway, so the route line is the useful thing.
  const stops = markers.filter((m) => m.kind !== 'bus');

  return (
    <View style={[styles.panel, style]}>
      <Text style={styles.heading}>Route order</Text>

      <View style={styles.line}>
        {stops.map((stop, i) => {
          const mine = stop.kind === 'pickup';
          return (
            <View key={stop.id} style={styles.row}>
              <View style={styles.rail}>
                <View style={[styles.dot, mine && styles.dotMine]} />
                {i < stops.length - 1 ? <View style={styles.connector} /> : null}
              </View>
              <Text style={[styles.stop, mine && styles.stopMine]} numberOfLines={2}>
                {stop.title}
                {mine ? '  ← your stop' : ''}
              </Text>
            </View>
          );
        })}
      </View>

      <Text style={styles.note}>
        Maps render on the phone app. The full address of every stop is listed below.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 16,
    gap: 12,
  },
  heading: { fontSize: 13, fontWeight: '700', color: theme.muted },
  line: { gap: 0 },
  row: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  rail: { alignItems: 'center', width: 12 },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.faint,
    marginTop: 4,
  },
  dotMine: { backgroundColor: theme.accent, width: 12, height: 12, borderRadius: 6 },
  connector: { width: 2, flex: 1, minHeight: 18, backgroundColor: theme.border },
  stop: { flex: 1, fontSize: 14, color: theme.text, paddingBottom: 14 },
  stopMine: { color: theme.accent, fontWeight: '700' },
  muted: { color: theme.faint, fontSize: 14, textAlign: 'center' },
  note: { fontSize: 12, color: theme.faint, lineHeight: 17 },
});
