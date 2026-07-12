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
import type { IncidentKind, Profile, RiderStatus, StudentTripStatus } from '../../../src/lib/types';
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
  const { rows, trips, loading, reload } = useTripStatuses();

  const [students, setStudents] = useState<Profile[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [incidentNote, setIncidentNote] = useState('');

  const trip = trips.find((t) => t.id === id) ?? null;
  const riders = useMemo(() => rows.filter((r) => r.trip_id === id), [rows, id]);
  const route = ref.routeOf(trip?.route_id);
  const vehicle = ref.vehicleOf(trip?.vehicle_id);
  const stops = ref.stopsFor(trip?.route_id);

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

  /** Blueprint: In Transit is set when the vehicle departs. */
  async function departed() {
    const boarded = riders.filter((r) => r.status === 'boarded');
    if (!boarded.length) {
      Alert.alert('Nobody is on board', 'Confirm at least one student boarded first.');
      return;
    }
    await supabase
      .from('student_trip_status')
      .update({ status: 'in_transit', updated_by: me })
      .in('id', boarded.map((r) => r.id));
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
            <Button label="Vehicle departed" variant="secondary" onPress={departed} />
            <Button label="End trip" variant="danger" onPress={endTrip} />
            <Text style={styles.fine}>
              You cannot end the trip until every student has an outcome. That is the point — it is
              how nobody gets left unaccounted for.
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

        return (
          <View key={stop.id} style={styles.stopBlock}>
            <SectionLabel>
              {stop.seq}. {ref.stopName(stop.id)}
              {stop.planned_arrival ? ` · ${stop.planned_arrival.slice(0, 5)}` : ''}
            </SectionLabel>

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

              return (
                <Card key={row.id} style={done ? styles.resolved : undefined}>
                  <Row style={styles.between}>
                    <View style={styles.grow}>
                      <Text style={styles.studentName}>{nameOf(row.student_id)}</Text>
                      <Text style={styles.fine}>
                        {row.check_in_time
                          ? `Checked in ${new Date(row.check_in_time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} — they say they are at the hub`
                          : 'Not checked in'}
                      </Text>
                    </View>
                    <Badge
                      label={RIDER_STATUS_LABEL[row.status]}
                      tone={RIDER_STATUS_TONE[row.status]}
                    />
                  </Row>

                  {trip.status === 'active' && !done ? (
                    onboard ? (
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
                    ) : (
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
                    )
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
  skip: { backgroundColor: theme.surfaceAlt },
  skipText: { fontSize: 13, color: theme.muted },
  urgent: { borderColor: theme.danger, backgroundColor: '#2A1D1D' },
  urgentTitle: { fontSize: 15, fontWeight: '700', color: theme.danger },
  urgentBody: { fontSize: 13, color: theme.text, lineHeight: 19 },
  textarea: { minHeight: 76, textAlignVertical: 'top', paddingTop: 12 },
});
