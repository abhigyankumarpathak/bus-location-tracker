import { useMemo } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { AppleMaps, GoogleMaps } from 'expo-maps';

/**
 * One map component for the whole app.
 *
 * expo-maps is alpha in SDK 57 and deliberately does NOT ship a cross-platform
 * view: you get AppleMaps.View on iOS and GoogleMaps.View on Android, with
 * different prop shapes. Everything in the app talks to this wrapper instead,
 * so that split — and any future swap to react-native-maps — stays contained to
 * this file.
 */

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  title: string;
  /** Buses render distinctly from stops. */
  kind?: 'bus' | 'stop' | 'pickup';
}

interface MapProps {
  markers: MapMarker[];
  /** Draws the route line through these points, in order. */
  path?: { lat: number; lng: number }[];
  /** Where to point the camera. Defaults to the first marker. */
  center?: { lat: number; lng: number } | null;
  zoom?: number;
  style?: object;
}

const COLORS = {
  bus: '#F97316',
  stop: '#64748B',
  pickup: '#38BDF8',
};

const SF_SYMBOLS = {
  bus: 'bus.fill',
  stop: 'circle.fill',
  pickup: 'figure.wave',
};

export function Map({ markers, path = [], center, zoom = 13, style }: MapProps) {
  const focus = center ?? (markers.length ? { lat: markers[0].lat, lng: markers[0].lng } : null);

  const cameraPosition = useMemo(
    () =>
      focus
        ? { coordinates: { latitude: focus.lat, longitude: focus.lng }, zoom }
        : undefined,
    [focus?.lat, focus?.lng, zoom],
  );

  const coordinates = useMemo(
    () => path.map((p) => ({ latitude: p.lat, longitude: p.lng })),
    [path],
  );

  if (!focus) {
    return (
      <View style={[styles.placeholder, style]}>
        <Text style={styles.placeholderText}>Nothing to show on the map yet.</Text>
      </View>
    );
  }

  if (Platform.OS === 'ios') {
    return (
      <AppleMaps.View
        style={[styles.map, style]}
        cameraPosition={cameraPosition}
        markers={markers.map((m) => ({
          id: m.id,
          coordinates: { latitude: m.lat, longitude: m.lng },
          title: m.title,
          tintColor: COLORS[m.kind ?? 'stop'],
          systemImage: SF_SYMBOLS[m.kind ?? 'stop'],
        }))}
        polylines={coordinates.length > 1 ? [{ coordinates, color: '#38BDF8', width: 4 }] : []}
        uiSettings={{ myLocationButtonEnabled: false }}
      />
    );
  }

  if (Platform.OS === 'android') {
    return (
      <GoogleMaps.View
        style={[styles.map, style]}
        cameraPosition={cameraPosition}
        markers={markers.map((m) => ({
          id: m.id,
          coordinates: { latitude: m.lat, longitude: m.lng },
          title: m.title,
          snippet: m.kind === 'bus' ? 'Live position' : undefined,
        }))}
        polylines={coordinates.length > 1 ? [{ coordinates, color: '#38BDF8', width: 4 }] : []}
      />
    );
  }

  // expo-maps has no web implementation.
  return (
    <View style={[styles.placeholder, style]}>
      <Text style={styles.placeholderText}>Maps are only available on iOS and Android.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  map: {
    flex: 1,
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0F172A',
    borderRadius: 16,
  },
  placeholderText: {
    color: '#64748B',
    fontSize: 14,
  },
});
