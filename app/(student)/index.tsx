import { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../src/lib/auth';
import { useFeatures } from '../../src/lib/org';
import { supabase } from '../../src/lib/supabase';
import { ensureTodaysTrips, useReference, useTripStatuses } from '../../src/lib/hooks';
import {
  RIDER_STATUS_LABEL,
  RIDER_STATUS_TONE,
  ROUTE_TYPE_LABEL,
  isFinal,
} from '../../src/lib/types';
import type { StudentTripStatus } from '../../src/lib/types';
import { ALERT_MINUTES, scheduleArrivalAlerts } from '../../src/lib/alerts';
import { GpsDisabled } from '../../src/components/Disabled';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorText,
  Loading,
  Row,
  Screen,
  SectionLabel,
  Title,
  theme,
} from '../../src/components/ui';

/**
 * The student's Today screen (blueprint §4.1).
 *
 * The single most important rule in this app lives here: **Check In means "I am
 * waiting at the hub". It does not mean "I boarded."**
 *
 * Only the driver can mark a student Boarded or Dropped Off, and the database
 * enforces it — the student's RLS policy permits exactly one target status,
 * `waiting`. That matters because a self-reported boarding could be wrong (a
 * child taps it and then misses the van) and the school would believe a missing
 * child was safely aboard. Blueprint §2.1: "Student-submitted check-in means 'I
 * am waiting'; it does not prove the student boarded."
 */
export default function StudentToday() {
  const { session, profile } = useAuth();
  const { gpsEnabled } = useFeatures();
  const me = session?.user.id;

  const ref = useReference();
  const { rows, trips, loading, reload, driverOf } = useTripStatuses();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    ensureTodaysTrips().then(reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mine = rows.filter((r) => r.student_id === me);

  // Blueprint §4.1: alerts 15 and 5 minutes before the van is due. Driven off
  // the planned arrival time, not GPS — see src/lib/alerts.ts.
  useEffect(() => {
    if (ref.loading) return;

    const arrivals = mine
      .map((row) => {
        const stop = ref.stops.find((s) => s.id === row.pickup_stop_id);
        const when = stop?.planned_arrival ?? stop?.planned_departure;
        const hub = ref.stopName(row.pickup_stop_id);
        // Nothing to alert on until the office has set a time for this hub.
        if (!when || !hub) return null;
        return { id: row.id, hubName: hub, plannedArrival: when };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);

    scheduleArrivalAlerts(arrivals);
  }, [mine, ref.loading, ref.stops, ref.stopName]);

  async function checkIn(row: StudentTripStatus) {
    setError('');
    setBusy(true);
    const { error: e } = await supabase
      .from('student_trip_status')
      .update({ status: 'waiting', check_in_time: new Date().toISOString(), updated_by: me })
      .eq('id', row.id);
    setBusy(false);

    if (e) {
      setError(e.message);
      return;
    }
    await reload();
    Alert.alert(
      'Checked in',
      'Your driver and the transport office know you are waiting at the hub. The driver will confirm you on board when you get on.',
    );
  }

  if (loading || ref.loading) return <Loading />;

  if (!mine.length) {
    return (
      <Screen>
        <Title sub={profile?.full_name || undefined}>Today</Title>
        {/* Blueprint §4.1: say this plainly rather than showing an empty page. */}
        <Empty>No transportation scheduled today.</Empty>
        <Card>
          <Text style={styles.fine}>
            If that looks wrong, the transport office may not have assigned you to a route yet.
          </Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <Title sub={profile?.full_name || undefined}>Today</Title>

      {mine.map((row) => {
        const trip = trips.find((t) => t.id === row.trip_id);
        const route = ref.routeOf(trip?.route_id);
        const vehicle = ref.vehicleOf(trip?.vehicle_id);
        const hub = ref.stopName(row.pickup_stop_id);
        const stop = ref.stops.find((s) => s.id === row.pickup_stop_id);

        const canCheckIn = row.status === 'scheduled';
        const done = isFinal(row.status);

        return (
          <Card key={row.id}>
            <Row style={styles.between}>
              <View style={styles.grow}>
                <Text style={styles.routeName}>
                  {route ? ROUTE_TYPE_LABEL[route.type] : 'Trip'}
                </Text>
                <Text style={styles.fine}>{route?.name}</Text>
              </View>
              <Badge label={RIDER_STATUS_LABEL[row.status]} tone={RIDER_STATUS_TONE[row.status]} />
            </Row>

            <Detail label="Hub" value={hub ?? 'Not assigned'} />
            {/* The "which corner exactly" line. Only shown once the office has
                filled it in — an empty row would be worse than none. */}
            {ref.stopAddress(row.pickup_stop_id) ? (
              <Text style={styles.address}>📍 {ref.stopAddress(row.pickup_stop_id)}</Text>
            ) : null}
            <Detail
              label="Van due"
              value={
                stop?.planned_arrival?.slice(0, 5) ??
                stop?.planned_departure?.slice(0, 5) ??
                'Time not set'
              }
            />
            <Detail label="Vehicle" value={vehicle ? vehicle.label : 'Not assigned'} />
            {/* Blueprint §4.1 asks for the driver's FIRST name only — the
                student has no need for the rest. */}
            <Detail
              label="Driver"
              value={driverOf(trip?.driver_id)?.full_name.split(' ')[0] ?? 'Not assigned'}
            />

            {/* Blueprint §4.1: alerts 15 and 5 minutes before the van is due. */}
            {stop?.planned_arrival || stop?.planned_departure ? (
              <Text style={styles.fine}>
                🔔 You will be alerted {ALERT_MINUTES.join(' and ')} minutes before the van is due
                at {hub}.
              </Text>
            ) : (
              <Text style={styles.warn}>
                The transport office has not set an arrival time for this hub yet, so there are no
                alerts for it.
              </Text>
            )}

            {canCheckIn ? (
              <>
                <Button
                  label="Check in — I'm at the hub"
                  onPress={() => checkIn(row)}
                  loading={busy}
                />
                <Text style={styles.fine}>
                  This tells your driver you are waiting. It does not mark you as on board — only
                  the driver can do that, once you actually get on.
                </Text>
              </>
            ) : row.status === 'waiting' ? (
              <Text style={styles.waiting}>
                You are checked in. The driver will confirm you on board when you get on the van.
              </Text>
            ) : done ? (
              <Text style={styles.done}>Nothing more to do today.</Text>
            ) : (
              <Text style={styles.fine}>
                Recorded by your driver
                {row.board_time
                  ? ` at ${new Date(row.board_time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                  : ''}
                .
              </Text>
            )}
          </Card>
        );
      })}

      <ErrorText>{error}</ErrorText>

      <SectionLabel>Where is the van?</SectionLabel>
      {gpsEnabled ? (
        <Empty>Live tracking is enabled. The map appears here once the van reports.</Empty>
      ) : (
        <GpsDisabled />
      )}
    </Screen>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  between: { justifyContent: 'space-between' },
  grow: { flex: 1 },
  routeName: { fontSize: 17, fontWeight: '700', color: theme.text },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  warn: { fontSize: 12, color: theme.warn, lineHeight: 17 },
  address: { fontSize: 13, color: theme.muted, lineHeight: 18 },
  waiting: { fontSize: 13, color: theme.warn, lineHeight: 19 },
  done: { fontSize: 13, color: theme.success },
  detail: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  detailLabel: { fontSize: 14, color: theme.muted },
  detailValue: {
    fontSize: 14,
    color: theme.text,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
  },
});
