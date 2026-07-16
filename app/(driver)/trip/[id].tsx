import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../../src/lib/auth';
import { useFeatures } from '../../../src/lib/org';
import { supabase } from '../../../src/lib/supabase';
import { useReference, useTripStatuses } from '../../../src/lib/hooks';
import {
  RIDER_STATUS_LABEL,
  RIDER_STATUS_TONE,
  ROUTE_TYPE_LABEL,
  isFinal,
} from '../../../src/lib/types';
import type {
  IncidentKind,
  Profile,
  RiderStatus,
  StudentTripStatus,
} from '../../../src/lib/types';
import { GpsDisabled } from '../../../src/components/Disabled';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorText,
  Field,
  Loading,
  Row,
  Screen,
  SectionLabel,
  Title,
  theme,
} from '../../../src/components/ui';

/**
 * The trip screen: overview, stop roster, student actions, incidents, end trip.
 *
 * The driver is the OFFICIAL record (blueprint §2.1). Everything a student or
 * parent said is a claim; what gets confirmed here is what happened. The
 * database backs that up — the student's RLS policy cannot write any status but
 * `waiting`.
 */

/** Blueprint §5.1: the actions a driver can take on a student. */
const ACTIONS: { status: RiderStatus; label: string; variant?: 'primary' | 'secondary' | 'danger' }[] = [
  { status: 'boarded', label: 'Boarded' },
  { status: 'no_show', label: 'No-Show', variant: 'danger' },
  { status: 'absent', label: 'Absent', variant: 'secondary' },
  { status: 'parent_pickup', label: 'Parent pickup', variant: 'secondary' },
];

const DROP_ACTIONS: { status: RiderStatus; label: string; variant?: 'primary' | 'danger' }[] = [
  { status: 'dropped_off', label: 'Dropped off safely' },
  { status: 'unable_to_drop_off', label: 'Unable to drop off', variant: 'danger' },
];

export default function DriverTrip() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const { gpsEnabled } = useFeatures();
  const me = session?.user.id;

  const ref = useReference();
  const { rows, trips, progress, loading, reload } = useTripStatuses();

  const [students, setStudents] = useState<Profile[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyStop, setBusyStop] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [incidentNote, setIncidentNote] = useState('');

  const trip = trips.find((t) => t.id === id) ?? null;
  const riders = useMemo(() => rows.filter((r) => r.trip_id === id), [rows, id]);
  const route = ref.routeOf(trip?.route_id);
  const vehicle = ref.vehicleOf(trip?.vehicle_id);
  const stops = ref.stopsFor(trip?.route_id);

  // The stops the driver actually works, in order — the ones with a rider to
  // board or drop off. Stops with nobody on them are hidden from the roster, so
  // they must NOT sit in the arrive/depart sequence either: gating a stop on a
  // hidden previous stop being "departed" left it stuck on "Not reached yet"
  // forever, with no Arrived button. The sequence runs over these, not all stops.
  const activeStops = useMemo(
    () =>
      stops.filter((s) =>
        riders.some((r) => r.pickup_stop_id === s.id || r.dropoff_stop_id === s.id),
      ),
    [stops, riders],
  );

  const loadStudents = useCallback(async () => {
    if (!riders.length) return;
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .in('id', riders.map((r) => r.student_id));
    setStudents((data as Profile[]) ?? []);
  }, [riders.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadStudents();
  }, [loadStudents]);

  const nameOf = (studentId: string) =>
    students.find((s) => s.id === studentId)?.full_name ?? 'Student';

  const progressOf = (stopId: string) =>
    progress.find((p) => p.trip_id === id && p.stop_id === stopId);
  const fmtTime = (t: string) =>
    new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  async function markArrived(stopId: string) {
    setBusyStop(stopId);
    setError('');
    const { error: e } = await supabase
      .from('trip_stop_progress')
      .upsert(
        { trip_id: id, stop_id: stopId, arrived_at: new Date().toISOString() },
        { onConflict: 'trip_id,stop_id' },
      );
    setBusyStop(null);
    if (e) return setError(e.message);
    await reload();
  }

  async function markDeparted(stopId: string) {
    setBusyStop(stopId);
    setError('');
    // Leaving a stop puts everyone who boarded THERE in transit. This is what the
    // single "Vehicle departed" button used to do for the whole trip at once; now
    // it happens stop by stop, so a parent sees "in transit" the moment the van
    // actually pulls away from their child's hub.
    const boardedHere = riders.filter(
      (r) => r.pickup_stop_id === stopId && r.status === 'boarded',
    );
    const { error: e } = await supabase
      .from('trip_stop_progress')
      .upsert(
        { trip_id: id, stop_id: stopId, departed_at: new Date().toISOString() },
        { onConflict: 'trip_id,stop_id' },
      );
    if (e) {
      setBusyStop(null);
      return setError(e.message);
    }
    if (boardedHere.length) {
      await supabase
        .from('student_trip_status')
        .update({ status: 'in_transit', updated_by: me })
        .in('id', boardedHere.map((r) => r.id));
    }
    setBusyStop(null);
    await reload();
  }

  async function setStatus(row: StudentTripStatus, status: RiderStatus, note?: string) {
    setError('');
    setBusyId(row.id);

    const patch: Record<string, unknown> = { status, updated_by: me, updated_at: new Date().toISOString() };
    if (status === 'boarded') patch.board_time = new Date().toISOString();
    if (status === 'dropped_off') patch.dropoff_time = new Date().toISOString();
    if (note) patch.note = note;

    const { error: e } = await supabase.from('student_trip_status').update(patch).eq('id', row.id);
    setBusyId(null);

    if (e) {
      setError(e.message);
      return;
    }
    await reload();
  }

  function confirmUnableToDrop(row: StudentTripStatus) {
    // Blueprint §6.3: the student stays onboard and the coordinator must act.
    // This blocks the trip from closing, so make sure it is not a misfire.
    Alert.alert(
      `Unable to drop off ${nameOf(row.student_id)}?`,
      'The student stays on the vehicle and the transport office is alerted immediately. You will not be able to end this trip until a coordinator resolves it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          style: 'destructive',
          onPress: () =>
            setStatus(row, 'unable_to_drop_off', 'Driver could not complete the drop-off.'),
        },
      ],
    );
  }

  async function startTrip() {
    if (!trip) return;
    const { error: e } = await supabase
      .from('daily_trips')
      .update({ status: 'active', started_at: new Date().toISOString() })
      .eq('id', trip.id);
    if (e) setError(e.message);
    await reload();
  }

  async function endTrip() {
    if (!trip) return;

    // The database refuses this if anyone is unresolved, but checking here lets
    // us say WHO, rather than showing a bare Postgres error.
    const unresolved = riders.filter((r) => !isFinal(r.status));
    if (unresolved.length) {
      Alert.alert(
        'Cannot end the trip yet',
        `These students have no final status:\n\n${unresolved
          .map((r) => `• ${nameOf(r.student_id)} — ${RIDER_STATUS_LABEL[r.status]}`)
          .join('\n')}\n\nEvery student must end the trip with an outcome.`,
      );
      return;
    }

    const { error: e } = await supabase
      .from('daily_trips')
      .update({ status: 'completed', ended_at: new Date().toISOString() })
      .eq('id', trip.id);

    if (e) {
      setError(e.message);
      return;
    }
    await reload();
    Alert.alert('Trip completed', 'Every student has a final status.');
    router.back();
  }

  async function reportIncident(kind: IncidentKind) {
    if (!trip || !me) return;
    const { error: e } = await supabase.from('incidents').insert({
      trip_id: trip.id,
      driver_id: me,
      kind,
      severity: kind === 'accident' ? 'high' : kind === 'breakdown' ? 'medium' : 'low',
      description: incidentNote.trim() || null,
    });
    if (e) {
      setError(e.message);
      return;
    }
    setIncidentNote('');
    Alert.alert('Reported', 'The transport office and affected parents have been notified.');
  }

  if (loading || ref.loading) return <Loading />;
  if (!trip) return <Empty>Trip not found, or it is not assigned to you.</Empty>;

  const resolved = riders.filter((r) => isFinal(r.status)).length;
  const stuck = riders.filter((r) => r.status === 'unable_to_drop_off');

  return (
    <Screen>
      <Title sub={`${route?.name ?? ''} · ${vehicle?.label ?? 'No vehicle'}`}>
        {route ? ROUTE_TYPE_LABEL[route.type] : 'Trip'}
      </Title>

      <Card>
        <Row style={styles.between}>
          <Text style={styles.progress}>
            {resolved} of {riders.length} students resolved
          </Text>
          <Badge
            label={trip.status === 'active' ? 'In progress' : trip.status === 'completed' ? 'Completed' : 'Scheduled'}
            tone={trip.status === 'active' ? 'accent' : trip.status === 'completed' ? 'success' : 'neutral'}
          />
        </Row>

        {trip.status === 'scheduled' ? (
          <Button label="Start trip" onPress={startTrip} />
        ) : trip.status === 'active' ? (
          <>
            <Button label="End trip" variant="danger" onPress={endTrip} />
            <Text style={styles.fine}>
              Work down the stops: arrive, board or drop off, then depart — the next stop unlocks
              when you leave this one. You cannot end the trip until every student has an outcome.
            </Text>
          </>
        ) : (
          <Text style={styles.done}>This trip is complete.</Text>
        )}
      </Card>

      {stuck.length > 0 ? (
        <Card style={styles.urgent}>
          <Text style={styles.urgentTitle}>⚠ Unresolved drop-off</Text>
          <Text style={styles.urgentBody}>
            {stuck.map((r) => nameOf(r.student_id)).join(', ')} could not be dropped off and{' '}
            {stuck.length === 1 ? 'is' : 'are'} still on the vehicle. The transport office has been
            alerted and must resolve this before the trip can close.
          </Text>
        </Card>
      ) : null}

      <ErrorText>{error}</ErrorText>

      {/* Stop roster (blueprint §5.1), grouped by the hub each student uses. */}
      {stops.map((stop) => {
        const atStop = riders.filter(
          (r) => r.pickup_stop_id === stop.id || r.dropoff_stop_id === stop.id,
        );
        if (!atStop.length) return null;

        const allAway = atStop.every((r) => ['absent', 'parent_pickup'].includes(r.status));

        // Where the school sits on the route decides which action it can have.
        // Afternoon runs school -> hub, so the school is the ORIGIN: the van
        // starts there, it never "arrives". Morning/club run hub -> school, so
        // the school is the DESTINATION: the van ends there, it never departs.
        const isSchool = Boolean(stop.school_id);
        const isOrigin = isSchool && route?.type === 'afternoon';
        const isDestination = isSchool && route?.type !== 'afternoon';

        const prog = progressOf(stop.id);
        const arrived = Boolean(prog?.arrived_at) || isOrigin;
        const departed = Boolean(prog?.departed_at);
        // A stop is reachable once the PREVIOUS STAFFED stop has been left behind
        // — walking the stops the driver actually sees, so an empty stop in the
        // middle of the route never blocks the next one. This is what keeps the
        // flow one-way: depart here, and the next stop with riders opens.
        const activeIdx = activeStops.findIndex((s) => s.id === stop.id);
        const prevActive = activeIdx > 0 ? activeStops[activeIdx - 1] : null;
        const reachable = !prevActive || Boolean(progressOf(prevActive.id)?.departed_at);
        const active = trip.status === 'active';

        const canArrive = active && !isOrigin && !prog?.arrived_at && reachable && !departed;
        // An all-away stop can be left without arriving — there is nobody to see.
        const canDepart = active && !isDestination && !departed && reachable && (arrived || allAway);

        return (
          <View key={stop.id} style={styles.stopBlock}>
            <SectionLabel>
              {stop.seq}. {ref.stopName(stop.id)}
              {stop.planned_arrival ? ` · ${stop.planned_arrival.slice(0, 5)}` : ''}
            </SectionLabel>

            {/* The van's progress through this stop. */}
            {active || prog ? (
              <Card style={styles.progressCard}>
                <Text style={styles.fine}>
                  {prog?.arrived_at
                    ? `Arrived ${fmtTime(prog.arrived_at)}`
                    : isOrigin
                      ? 'Start of the route'
                      : reachable
                        ? 'Van is due here next'
                        : 'Not reached yet'}
                  {prog?.departed_at
                    ? ` · Departed ${fmtTime(prog.departed_at)}`
                    : isDestination
                      ? ' · final stop'
                      : ''}
                </Text>
                {canArrive || canDepart ? (
                  <Row style={styles.wrap}>
                    {canArrive ? (
                      <Button
                        label="Arrived at this stop"
                        variant="secondary"
                        loading={busyStop === stop.id}
                        style={styles.action}
                        onPress={() => markArrived(stop.id)}
                      />
                    ) : null}
                    {canDepart ? (
                      <Button
                        label={allAway && !arrived ? 'Skip this stop' : 'Departed this stop'}
                        loading={busyStop === stop.id}
                        style={styles.action}
                        onPress={() => markDeparted(stop.id)}
                      />
                    ) : null}
                  </Row>
                ) : null}
              </Card>
            ) : null}

            {/* Blueprint §5.1: see absentees and skip those stops. */}
            {allAway ? (
              <Card style={styles.skip}>
                <Text style={styles.skipText}>
                  Everyone at this stop is away today — you can skip it.
                </Text>
              </Card>
            ) : null}

            {atStop.map((row) => {
              const done = isFinal(row.status);
              const onboard = ['boarded', 'in_transit'].includes(row.status);

              // A student sits at TWO stops on a route: the one they board at and
              // the one they get off at. Morning that is hub -> school; afternoon
              // it is school -> hub. Which card this is decides which actions
              // belong here — boarding controls only where they board, drop-off
              // controls only where they get off. Without this, a boarded student
              // showed "Dropped off safely" at BOTH stops.
              const isPickupStop = row.pickup_stop_id === stop.id;
              const isDropoffStop = row.dropoff_stop_id === stop.id;
              const showBoarding = trip.status === 'active' && !done && isPickupStop && !onboard;
              const showDropoff = trip.status === 'active' && !done && isDropoffStop && onboard;
              const fmt = (t: string) =>
                new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

              return (
                <Card key={row.id} style={done ? styles.resolved : undefined}>
                  <Row style={styles.between}>
                    <View style={styles.grow}>
                      <Text style={styles.studentName}>{nameOf(row.student_id)}</Text>
                      <Text style={styles.fine}>
                        {isPickupStop
                          ? row.check_in_time
                            ? `Checked in ${fmt(row.check_in_time)} — they say they are waiting`
                            : 'Not checked in'
                          : row.board_time
                            ? `On board since ${fmt(row.board_time)} — drop off here`
                            : 'Boards earlier on this route'}
                      </Text>
                    </View>
                    <Badge
                      label={RIDER_STATUS_LABEL[row.status]}
                      tone={RIDER_STATUS_TONE[row.status]}
                    />
                  </Row>

                  {showBoarding ? (
                    <Row style={styles.wrap}>
                      {ACTIONS.map((a) => (
                        <Button
                          key={a.status}
                          label={a.label}
                          variant={a.variant}
                          loading={busyId === row.id}
                          style={styles.action}
                          onPress={() => setStatus(row, a.status)}
                        />
                      ))}
                    </Row>
                  ) : showDropoff ? (
                    <Row style={styles.wrap}>
                      {DROP_ACTIONS.map((a) => (
                        <Button
                          key={a.status}
                          label={a.label}
                          variant={a.variant}
                          loading={busyId === row.id}
                          style={styles.action}
                          onPress={() =>
                            a.status === 'unable_to_drop_off'
                              ? confirmUnableToDrop(row)
                              : setStatus(row, a.status)
                          }
                        />
                      ))}
                    </Row>
                  ) : null}
                </Card>
              );
            })}
          </View>
        );
      })}

      {riders.length === 0 ? <Empty>No students on this trip.</Empty> : null}

      <SectionLabel>Report an incident</SectionLabel>
      <Card>
        <Field
          label="What happened?"
          value={incidentNote}
          onChangeText={setIncidentNote}
          placeholder="Heavy traffic on Homestead — about 15 minutes behind."
          multiline
          numberOfLines={3}
          style={styles.textarea}
        />
        <Row style={styles.wrap}>
          <Button label="Delay" variant="secondary" style={styles.action} onPress={() => reportIncident('delay')} />
          <Button label="Breakdown" variant="secondary" style={styles.action} onPress={() => reportIncident('breakdown')} />
          <Button label="Accident" variant="danger" style={styles.action} onPress={() => reportIncident('accident')} />
        </Row>
      </Card>

      <SectionLabel>Navigation</SectionLabel>
      {gpsEnabled ? (
        <Empty>Live tracking is on.</Empty>
      ) : (
        <GpsDisabled compact />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  between: { justifyContent: 'space-between' },
  grow: { flex: 1 },
  wrap: { flexWrap: 'wrap' },
  action: { flexGrow: 1, minWidth: 120, paddingVertical: 16 },
  progress: { fontSize: 16, fontWeight: '700', color: theme.text },
  studentName: { fontSize: 17, fontWeight: '700', color: theme.text },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  done: { fontSize: 14, color: theme.success },
  resolved: { opacity: 0.65 },
  stopBlock: { gap: 12 },
  progressCard: { gap: 10, backgroundColor: theme.surfaceAlt },
  skip: { backgroundColor: theme.surfaceAlt },
  skipText: { fontSize: 13, color: theme.muted },
  urgent: { borderColor: theme.danger, backgroundColor: '#2A1D1D' },
  urgentTitle: { fontSize: 15, fontWeight: '700', color: theme.danger },
  urgentBody: { fontSize: 13, color: theme.text, lineHeight: 19 },
  textarea: { minHeight: 76, textAlignVertical: 'top', paddingTop: 12 },
});
