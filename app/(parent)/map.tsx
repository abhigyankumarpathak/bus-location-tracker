import { useEffect, useMemo, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFeatures } from '../../src/lib/org';
import { useMyChildren, useReference, useTripStatuses } from '../../src/lib/hooks';
import { ROUTE_TYPE_LABEL } from '../../src/lib/types';
import { Map } from '../../src/components/Map';
import type { MapMarker } from '../../src/components/Map';
import { GpsDisabled } from '../../src/components/Disabled';
import {
  Badge,
  Button,
  Card,
  Empty,
  Loading,
  Row,
  Screen,
  SectionLabel,
  Title,
  theme,
} from '../../src/components/ui';

/**
 * The route map (blueprint §7.3: "Display hub pins only in MVP; live GPS and
 * navigation postponed").
 *
 * This is exactly that, and no more: where the hubs are, where the school is,
 * and the order the van visits them. No vehicle, because there is no vehicle
 * position to show — and the panel below the map says so, and quotes the reason,
 * rather than leaving a blank space that looks like a bug.
 *
 * A parent picks which route to look at. It defaults to the one their child
 * actually rides; they can switch to another (the school's routes and hubs are
 * not secret, and a parent moving house wants to see the other options before
 * asking the office to move their child).
 */
export default function ParentMap() {
  const { gpsEnabled } = useFeatures();
  const { children, loading: childrenLoading } = useMyChildren();
  const ref = useReference();
  const { rows, trips } = useTripStatuses();

  const [routeId, setRouteId] = useState<string | null>(null);

  // Default to the route the child actually rides today.
  const childRouteId = useMemo(() => {
    const mine = rows.find((r) => children.some((c) => c.id === r.student_id));
    const trip = trips.find((t) => t.id === mine?.trip_id);
    return trip?.route_id ?? null;
  }, [rows, trips, children]);

  useEffect(() => {
    if (!routeId) setRouteId(childRouteId ?? ref.routes[0]?.id ?? null);
  }, [childRouteId, ref.routes, routeId]);

  const route = ref.routeOf(routeId);
  const stops = ref.stopsFor(routeId);

  // The hub each of this parent's children uses, so their own stop stands out
  // from the rest of the line. This is the HUB, not the school: afternoon runs
  // school -> hub, so pickup_stop_id there is the school. hubStopId picks
  // whichever of pickup/drop-off is the hub, in either direction.
  const myStopIds = useMemo(
    () =>
      new Set(
        rows
          .filter((r) => children.some((c) => c.id === r.student_id))
          .map((r) => ref.hubStopId(r.pickup_stop_id, r.dropoff_stop_id))
          .filter(Boolean) as string[],
      ),
    [rows, children, ref],
  );

  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    for (const stop of stops) {
      const at = ref.stopCoords(stop.id);
      // A stop with no location cannot be pinned. It still appears in the list
      // below, flagged, so the office can see what is missing.
      if (!at) continue;
      out.push({
        id: stop.id,
        lat: at.lat,
        lng: at.lng,
        title: `${stop.seq}. ${ref.stopName(stop.id) ?? 'Stop'}`,
        kind: myStopIds.has(stop.id) ? 'pickup' : 'stop',
      });
    }
    return out;
  }, [stops, ref, myStopIds]);

  const path = useMemo(
    () =>
      stops
        .map((s) => ref.stopCoords(s.id))
        .filter((c): c is { lat: number; lng: number } => c !== null),
    [stops, ref],
  );

  function openInMaps(lat: number, lng: number, label: string) {
    const url = Platform.select({
      ios: `maps://?daddr=${lat},${lng}&q=${encodeURIComponent(label)}`,
      android: `geo:${lat},${lng}?q=${encodeURIComponent(label)}`,
      default: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`,
    });
    Linking.openURL(url);
  }

  if (childrenLoading || ref.loading) return <Loading />;

  if (ref.routes.length === 0) {
    return (
      <Screen>
        <Title sub="Where the van stops.">Route map</Title>
        <Empty>No routes have been set up yet.</Empty>
      </Screen>
    );
  }

  return (
    <Screen>
      <Title sub={route ? ROUTE_TYPE_LABEL[route.type] : 'Where the van stops'}>Route map</Title>

      {/* Which bus. Defaults to the child's own; a parent can look at any. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {ref.routes.map((r) => {
          const mine = r.id === childRouteId;
          return (
            <Pressable
              key={r.id}
              onPress={() => setRouteId(r.id)}
              style={[styles.chip, routeId === r.id && styles.chipActive]}
            >
              <Text style={[styles.chipText, routeId === r.id && styles.chipTextActive]}>
                {r.name}
                {mine ? ' ★' : ''}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {childRouteId ? (
        <Text style={styles.fine}>★ is the route your child rides.</Text>
      ) : null}

      {markers.length > 0 ? (
        <Card style={styles.mapCard}>
          <Map markers={markers} path={path} style={styles.map} zoom={13} />
        </Card>
      ) : (
        <Empty>
          None of the stops on this route have a location set yet. The transport office adds them in
          Setup → Hubs.
        </Empty>
      )}

      {/* Blueprint §7.3 — hub pins only. Say why the van is not on the map,
          rather than leaving a gap that looks broken. */}
      {gpsEnabled ? null : <GpsDisabled />}

      <SectionLabel>Stops, in order</SectionLabel>

      {stops.length === 0 ? <Empty>This route has no stops yet.</Empty> : null}

      {stops.map((stop) => {
        const at = ref.stopCoords(stop.id);
        const name = ref.stopName(stop.id);
        const address = ref.stopAddress(stop.id);
        const isSchool = Boolean(stop.school_id);
        const isMine = myStopIds.has(stop.id);

        return (
          <Card key={stop.id} style={isMine ? styles.mine : undefined}>
            <Row style={styles.between}>
              <View style={styles.grow}>
                <Text style={styles.stopName}>
                  {stop.seq}. {name}
                  {isSchool ? ' 🏫' : ''}
                </Text>
                {address ? (
                  <Text style={styles.address}>📍 {address}</Text>
                ) : (
                  <Text style={styles.noAddress}>No address set for this stop yet.</Text>
                )}
                <Text style={styles.fine}>
                  {stop.planned_arrival
                    ? `Van due ${stop.planned_arrival.slice(0, 5)}`
                    : 'No arrival time set'}
                  {stop.planned_departure ? ` · leaves ${stop.planned_departure.slice(0, 5)}` : ''}
                </Text>
              </View>
              {isMine ? <Badge label="Your stop" tone="accent" /> : null}
            </Row>

            {at ? (
              <Button
                label="Open in maps"
                variant="secondary"
                onPress={() => openInMaps(at.lat, at.lng, name ?? 'Stop')}
              />
            ) : null}
          </Card>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { gap: 8, paddingVertical: 2 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  chipActive: { borderColor: theme.accent, backgroundColor: theme.surfaceAlt },
  chipText: { color: theme.muted, fontWeight: '600' },
  chipTextActive: { color: theme.accent },
  mapCard: { padding: 0, overflow: 'hidden' },
  map: { height: 280 },
  mine: { borderColor: theme.accent },
  between: { justifyContent: 'space-between' },
  grow: { flex: 1 },
  stopName: { fontSize: 15, fontWeight: '700', color: theme.text },
  address: { fontSize: 13, color: theme.muted, lineHeight: 18 },
  noAddress: { fontSize: 12, color: theme.warn, lineHeight: 17 },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
});
