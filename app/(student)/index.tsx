import { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../src/lib/auth';
import { useFeatures } from '../../src/lib/org';
import { supabase } from '../../src/lib/supabase';
import {
  ensureTodaysTrips,
  useReference,
  useTripStatuses,
  useVehicleLocation,
} from '../../src/lib/hooks';
import {
  RIDER_STATUS_LABEL,
  RIDER_STATUS_TONE,
  ROUTE_TYPE_LABEL,
  decodeVanQr,
  isFinal,
} from '../../src/lib/types';
import type { SelfScanResult, StudentTripStatus } from '../../src/lib/types';
import { stopsStillToVisit } from '../../src/lib/eta';
import { BoardingScanner } from '../../src/components/BoardingScanner';
import type { ScanFeedback } from '../../src/components/BoardingScanner';
import { VanEta } from '../../src/components/VanEta';
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
import { PushStatus } from '../../src/components/PushStatus';

/**
 * The student's Today screen (blueprint §4.1).
 *
 * **Check In means "I am waiting at the hub". It does not mean "I boarded."**
 * The student's RLS policy still permits exactly one target status, `waiting`,
 * so nothing this screen can write moves them onto a van. Blueprint §2.1:
 * "Student-submitted check-in means 'I am waiting'; it does not prove the
 * student boarded."
 *
 * SCAN MODE IS THE EXCEPTION, and it is a narrow one. Since 26 August 2026 a
 * student in `attendance_mode = 'scan'` can board themselves by scanning the
 * printed card in the van — but not from here. It goes through
 * `board_by_vehicle_code()`, which is the only door, and which refuses unless
 * the van is standing at that student's own stop right now. The RLS policy
 * above is unchanged: a student calling PostgREST directly still cannot write
 * `boarded`.
 *
 * The driver has not gone anywhere either. They still confirm the departure, and
 * the app still refuses to leave a stop while a rostered student there has no
 * outcome — which is what ratifies the scans.
 */
export default function StudentToday() {
  const { session, profile } = useAuth();
  const { gpsEnabled, attendanceMode } = useFeatures();
  const me = session?.user.id;

  const ref = useReference();
  const { rows, trips, loading, reload, driverOf, stopProgressOf } = useTripStatuses();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Open the camera to board off the card in the van. Null = closed. */
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    ensureTodaysTrips().then(reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mine = rows.filter((r) => r.student_id === me);

  // Only a trip that is actually running has a van worth locating. A student may
  // have both legs of the day on this screen; at most one of them is under way.
  const runningTrip = trips.find(
    (t) => t.status === 'active' && mine.some((r) => r.trip_id === t.id),
  );
  const { location, stale } = useVehicleLocation(runningTrip?.vehicle_id, gpsEnabled);

  // Blueprint §4.1: alerts 15 and 5 minutes before the van is due.
  //
  // These used to be scheduled on the DEVICE from this screen, which meant they
  // only existed if the app had been opened that day, never worked on web at
  // all, and re-armed themselves on every render — cancelling every scheduled
  // notification globally each time. They now come from send_arrival_alerts() on
  // the server, so they arrive as push and land in the inbox like everything
  // else. Nothing to do here.

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
      attendanceMode === 'scan'
        ? 'Your driver and the transport office know you are waiting at the hub. Scan the code in the van when you get on.'
        : 'Your driver and the transport office know you are waiting at the hub. The driver will confirm you on board when you get on.',
    );
  }

  /**
   * Board off the card in the van.
   *
   * This screen decides nothing. It reads a code and hands it to the server,
   * which checks it against the trip that vehicle is running at that second —
   * including whether the van is actually at this student's stop. Every refusal
   * comes back as a sentence the student can act on rather than an error, because
   * the person reading it is fourteen and standing in the rain.
   */
  const resolveVanScan = useCallback(
    async (raw: string): Promise<ScanFeedback | null> => {
      const code = decodeVanQr(raw);
      // Not one of ours — a poster in the shelter behind the van. Say nothing and
      // keep looking.
      if (!code) return null;

      const { data, error: e } = await supabase.rpc('board_by_vehicle_code', { code });
      if (e) return { tone: 'danger', message: e.message };

      const verdict = data as SelfScanResult | null;
      if (!verdict) {
        return { tone: 'danger', message: 'That scan did not go through. Try again.' };
      }

      await reload();
      return { tone: verdict.tone, message: verdict.message };
    },
    [reload],
  );

  if (loading || ref.loading) return <Loading />;

  if (!mine.length) {
    return (
      <Screen>
        <Title sub={profile?.full_name || undefined}>Today</Title>
        <PushStatus compact />
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
      <PushStatus compact />

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

            {/* Where the van actually is, when tracking is on and this is the
                leg under way. Rendered above the scheduled line because a real
                position beats a timetable whenever we have one. */}
            {gpsEnabled && row.trip_id === runningTrip?.id ? (
              <VanEta
                location={location}
                stale={stale}
                target={ref.stopCoords(row.pickup_stop_id)}
                hubName={hub ?? 'your stop'}
                route={ref
                  .stopsFor(trip?.route_id)
                  .map((st) => ref.stopCoords(st.id))
                  .filter((c): c is { lat: number; lng: number } => c !== null)}
                stopsBefore={
                  row.pickup_stop_id
                    ? stopsStillToVisit(
                        ref.stopsFor(trip?.route_id),
                        row.pickup_stop_id,
                        (stopId) => Boolean(stopProgressOf(row.trip_id, stopId)?.departed_at),
                        ref.stopCoords,
                      )
                    : []
                }
              />
            ) : null}

            {/* Blueprint §4.1: alerts 15 and 5 minutes before the van is due. */}
            {stop?.planned_arrival || stop?.planned_departure ? (
              <Text style={styles.fine}>
                🔔 You will be alerted 15 and 5 minutes before the van is due at {hub}.
              </Text>
            ) : (
              <Text style={styles.warn}>
                The transport office has not set an arrival time for this hub yet, so there are no
                alerts for it.
              </Text>
            )}

            {/* Board yourself off the card in the van, when the office runs scan
                mode. Hidden once they are aboard — it has done its job, and
                leaving it up invites a second scan. */}
            {attendanceMode === 'scan' && !done && !['boarded', 'in_transit'].includes(row.status) ? (
              <>
                <Button label="Scan to board" onPress={() => setScanning(true)} />
                <Text style={styles.fine}>
                  The code is on a card by the van door. Scanning it is what marks you on board,
                  and it only works while the van is actually at {hub ?? 'your stop'}.
                </Text>
              </>
            ) : null}

            {canCheckIn ? (
              <>
                <Button
                  label="Check in — I'm at the hub"
                  onPress={() => checkIn(row)}
                  loading={busy}
                />
                <Text style={styles.fine}>
                  This tells your driver you are waiting. It does not mark you as on board —
                  {attendanceMode === 'scan'
                    ? ' scan the code in the van once you actually get on.'
                    : ' only the driver can do that, once you actually get on.'}
                </Text>
              </>
            ) : row.status === 'waiting' ? (
              <Text style={styles.waiting}>
                {attendanceMode === 'scan'
                  ? 'You are checked in. Scan the code in the van when you get on.'
                  : 'You are checked in. The driver will confirm you on board when you get on the van.'}
              </Text>
            ) : done ? (
              <Text style={styles.done}>Nothing more to do today.</Text>
            ) : (
              <Text style={styles.fine}>
                {/* Who actually recorded it. Saying "your driver" for a scan the
                    student made themselves would be a small lie in the one place
                    this app cannot afford them. */}
                {row.updated_by && row.updated_by === me ? 'You scanned on' : 'Recorded by your driver'}
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
      {!gpsEnabled ? (
        <GpsDisabled />
      ) : !runningTrip ? (
        <Empty>
          Live tracking is on. The van appears here once your driver starts the trip.
        </Empty>
      ) : location ? (
        <Card>
          <VanEta
            location={location}
            stale={stale}
            target={ref.stopCoords(mine.find((r) => r.trip_id === runningTrip.id)?.pickup_stop_id ?? null)}
            hubName={
              ref.stopName(mine.find((r) => r.trip_id === runningTrip.id)?.pickup_stop_id) ??
              'your stop'
            }
            route={ref
              .stopsFor(runningTrip.route_id)
              .map((st) => ref.stopCoords(st.id))
              .filter((c): c is { lat: number; lng: number } => c !== null)}
            showMap
          />
        </Card>
      ) : (
        <Empty>
          The trip has started but the van has not reported its position yet. It may still be
          getting signal.
        </Empty>
      )}

      {/* One camera for the whole screen, not one per leg — a student rides at
          most one van at a time, and the server works out which. */}
      <BoardingScanner
        visible={scanning}
        onClose={() => {
          setScanning(false);
          reload();
        }}
        onScan={resolveVanScan}
        title="Scan to board"
        subtitle="The card is by the van door"
        hint="Point the camera at the code inside the van."
        idle="Find the code by the door and point the camera at it."
        doneLabel="Close"
        deniedBody="Without the camera you cannot scan yourself on — ask the driver to board you by name instead."
        closeOnSuccess
      />
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
