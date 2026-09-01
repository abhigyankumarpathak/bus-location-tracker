import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../../src/lib/auth';
import { useFeatures } from '../../src/lib/org';
import { ensureTodaysTrips, useReference, useTripStatuses } from '../../src/lib/hooks';
import { startOutboxSync, stopOutboxSync } from '../../src/lib/outbox';
import { enforceTrackingScope } from '../../src/lib/tracking';
import { ROUTE_TYPE_LABEL, isFinal } from '../../src/lib/types';
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
import { OutboxBanner } from '../../src/components/OutboxBanner';
import { PushStatus } from '../../src/components/PushStatus';

/**
 * Today's Trips (blueprint §5.1).
 *
 * RLS means a driver only ever sees trips where they are the assigned driver —
 * "Drivers must never see routes that are not assigned to them" (§2.1) is
 * enforced in Postgres, not by filtering here.
 */
export default function DriverToday() {
  const { profile, signOut } = useAuth();
  const ref = useReference();
  const { attendanceOnly } = useFeatures();
  const { rows, trips, loading, reload } = useTripStatuses();

  useEffect(() => {
    ensureTodaysTrips().then(reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // C3: keep the queue draining while a driver has the app open. This screen is
  // the one a driver reliably opens, and it is also where they would land after
  // a route finished in a dead spot — so anything still unsent gets another go
  // here rather than waiting for them to reopen a trip.
  useEffect(() => {
    startOutboxSync();
    return () => stopOutboxSync();
  }, []);

  /**
   * A driver is followed while they are driving a route, and never otherwise.
   *
   * This screen is where the app learns which trips are actually running, so it
   * is where a location task left over from a forgotten "End trip" gets shut
   * down. Opening the app is the one thing a driver reliably does the next
   * morning, and it must not be the morning their phone has been reporting all
   * night.
   *
   * Runs once the trip list has loaded — an empty list before then would look
   * like "no route is running" and stop a perfectly good one.
   */
  useEffect(() => {
    if (loading) return;
    enforceTrackingScope(trips.filter((t) => t.status === 'active').map((t) => t.id));
  }, [loading, trips]);

  if (loading || ref.loading) return <Loading />;

  // Attendance-only mode has no trips, no routes and no driver role to speak of.
  // Say that plainly rather than showing an empty trip list, which reads as "the
  // office forgot to assign you" — the single most alarming thing a driver can
  // see at 6am.
  if (attendanceOnly) {
    return (
      <Screen>
        <Title sub={profile?.full_name || undefined}>Today</Title>
        <Card>
          <Text style={styles.routeName}>Attendance-only mode is on</Text>
          <Text style={styles.fine}>
            The transport office has switched this app to recording attendance only. There are no
            routes or trips to drive while it is on, and nothing is expected of you here.
          </Text>
          <Text style={styles.fine}>
            Your trips, and everything already recorded against them, are untouched — they return
            the moment the office switches the mode back off.
          </Text>
        </Card>
        <SectionLabel>Account</SectionLabel>
        <Button label="Sign out" variant="secondary" onPress={signOut} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title sub={profile?.full_name || undefined}>Today's trips</Title>

      <PushStatus compact />
      <OutboxBanner />

      {trips.length === 0 ? (
        <>
          <Empty>No trips assigned to you today.</Empty>
          <Card>
            <Text style={styles.fine}>
              The transport office assigns drivers to routes. If you should be driving today, ask
              them to put you on one.
            </Text>
          </Card>
        </>
      ) : null}

      {trips.map((trip) => {
        const route = ref.routeOf(trip.route_id);
        const vehicle = ref.vehicleOf(trip.vehicle_id);
        const riders = rows.filter((r) => r.trip_id === trip.id);
        const travelling = riders.filter(
          (r) => !['absent', 'parent_pickup'].includes(r.status),
        );
        const done = riders.filter((r) => isFinal(r.status)).length;
        const stops = ref.stopsFor(trip.route_id);

        // Blueprint §3.3: warn when the roster exceeds what the van holds.
        const overCapacity = vehicle ? travelling.length > vehicle.capacity : false;

        return (
          <Pressable
            key={trip.id}
            onPress={() => router.push(`/(driver)/trip/${trip.id}`)}
            style={({ pressed }) => [styles.trip, pressed && { opacity: 0.75 }]}
          >
            <Row style={styles.between}>
              <View style={styles.grow}>
                <Text style={styles.routeName}>
                  {route ? ROUTE_TYPE_LABEL[route.type] : 'Trip'}
                </Text>
                <Text style={styles.fine}>{route?.name}</Text>
              </View>
              <Badge
                label={
                  trip.status === 'active'
                    ? 'In progress'
                    : trip.status === 'completed'
                      ? 'Completed'
                      : 'Scheduled'
                }
                tone={
                  trip.status === 'active'
                    ? 'accent'
                    : trip.status === 'completed'
                      ? 'success'
                      : 'neutral'
                }
              />
            </Row>

            <Row style={styles.stats}>
              <Stat label="Departs" value={stops[0]?.planned_departure?.slice(0, 5) ?? '—'} />
              <Stat label="Students" value={String(travelling.length)} />
              <Stat label="Vehicle" value={vehicle?.label ?? '—'} />
              <Stat label="Resolved" value={`${done}/${riders.length}`} />
            </Row>

            {overCapacity ? (
              <Text style={styles.warn}>
                ⚠ {travelling.length} students but {vehicle?.label} seats {vehicle?.capacity}. Tell
                the transport office.
              </Text>
            ) : null}

            <Text style={styles.open}>Open trip ›</Text>
          </Pressable>
        );
      })}

      <SectionLabel>Account</SectionLabel>
      <Button label="Sign out" variant="secondary" onPress={signOut} />
    </Screen>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  trip: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 18,
    gap: 12,
  },
  between: { justifyContent: 'space-between' },
  grow: { flex: 1 },
  routeName: { fontSize: 20, fontWeight: '700', color: theme.text },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  warn: { fontSize: 13, color: theme.warn, lineHeight: 19 },
  stats: { gap: 0 },
  stat: { flex: 1, gap: 2 },
  statValue: { fontSize: 18, fontWeight: '700', color: theme.text },
  statLabel: { fontSize: 11, color: theme.faint },
  open: { fontSize: 14, fontWeight: '600', color: theme.accent },
});
