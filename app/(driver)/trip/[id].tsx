import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../../src/lib/auth';
import { useFeatures } from '../../../src/lib/org';
import { supabase } from '../../../src/lib/supabase';
import { useReference, useTripStatuses } from '../../../src/lib/hooks';
import { isTracking, reportOnce, startTracking, stopTracking } from '../../../src/lib/tracking';
import {
  RIDER_STATUS_LABEL,
  RIDER_STATUS_TONE,
  ROUTE_TYPE_LABEL,
  isAway,
  isFinal,
  unresolvedAtStop,
} from '../../../src/lib/types';
import type {
  IncidentKind,
  Profile,
  RiderLookup,
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
  const { gpsEnabled, attendanceMode, undoWindowSec } = useFeatures();
  const me = session?.user.id;

  const ref = useReference();
  const { rows, trips, progress, loading, reload } = useTripStatuses();

  const [students, setStudents] = useState<Profile[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyStop, setBusyStop] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [incidentNote, setIncidentNote] = useState('');
  const [delaying, setDelaying] = useState(false);

  /** C7: "this student isn't on my list" — who are they, and whose van? */
  const [lookupOpen, setLookupOpen] = useState(false);
  const [lookupName, setLookupName] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupHits, setLookupHits] = useState<RiderLookup[] | null>(null);

  /** Which rider is being boarded at a stop that is not theirs, and why. */
  const [wrongStopFor, setWrongStopFor] = useState<{ rowId: string; stopId: string } | null>(null);
  const [wrongStopNote, setWrongStopNote] = useState('');

  /**
   * Which stop the driver tried to leave with somebody unaccounted for. This is
   * the CLEARING step: the departure is held, the people with no outcome are
   * listed here with their buttons, and the driver either resolves them or
   * leaves anyway on the record.
   */
  const [blockedStop, setBlockedStop] = useState<string | null>(null);

  /** Which away student the driver is boarding anyway, and why. */
  const [turnUpId, setTurnUpId] = useState<string | null>(null);
  const [turnUpNote, setTurnUpNote] = useState('');

  /**
   * Drives the undo countdown.
   *
   * Undo is only offered for a few seconds, so the buttons have to disappear on
   * their own — a screen that keeps offering an undo the database will refuse is
   * worse than not offering one. Ticks only while the trip is running.
   */
  const [now, setNow] = useState(() => Date.now());

  /** What the van is actually doing about its position, in the driver's words. */
  const [trackingState, setTrackingState] = useState<'off' | 'background' | 'foreground'>('off');
  const [trackingNote, setTrackingNote] = useState('');

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

  /**
   * Begin reporting the van's position.
   *
   * Position comes from the DRIVER'S PHONE today. When a hardware tracker is
   * fitted to the van it POSTs to the ingest-location endpoint instead and this
   * call becomes unnecessary — nothing downstream changes, because both write the
   * same `vehicle_locations` rows and no reader knows the difference.
   *
   * A refused permission does not stop the route. The driver still has a trip to
   * run; they just get told plainly that the map will be empty, rather than the
   * parents seeing a van that never moves.
   */
  const beginTracking = useCallback(
    async (vehicleId: string | null, tripId: string) => {
      if (!gpsEnabled || !vehicleId) return;

      const result = await startTracking(vehicleId, tripId);

      if (!result.ok) {
        setTrackingState('off');
        setTrackingNote(result.message ?? 'The van is not reporting its position.');
        return;
      }
      setTrackingState(result.foregroundOnly ? 'foreground' : 'background');
      setTrackingNote(result.message ?? '');
    },
    [gpsEnabled],
  );

  // Pick tracking back up when the driver reopens the screen mid-route. The
  // background task survives the app being killed, but a driver who only granted
  // "While Using" is on the foreground timer below, and that dies with the screen.
  useEffect(() => {
    if (!gpsEnabled || !trip || trip.status !== 'active') return;

    let cancelled = false;
    (async () => {
      if (await isTracking()) {
        if (!cancelled) setTrackingState('background');
        return;
      }
      if (!cancelled) await beginTracking(trip.vehicle_id, trip.id);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpsEnabled, trip?.id, trip?.status, trip?.vehicle_id, beginTracking]);

  // Foreground-only fallback. Without background permission there is no task, so
  // the screen reports on a timer for as long as the driver is looking at it.
  //
  // Gated on the trip being ACTIVE, like everything else that touches location:
  // an open screen is not a running route. reportOnce() skips the write when the
  // van has not moved, so a van idling at a hub costs a GPS read and nothing else.
  useEffect(() => {
    if (trackingState !== 'foreground') return;
    if (!trip || trip.status !== 'active' || !trip.vehicle_id) return;

    const vehicleId = trip.vehicle_id;
    const tripId = trip.id;
    const tick = () => {
      reportOnce(vehicleId, tripId).catch(() => {
        // A dropped fix is not worth interrupting the driver over — the next one
        // is thirty seconds away.
      });
    };

    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackingState, trip?.id, trip?.status, trip?.vehicle_id]);

  useEffect(() => {
    if (trip?.status !== 'active') return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [trip?.status]);

  /** Is `at` still inside the undo window? */
  const undoable = useCallback(
    (at: string | null | undefined) =>
      Boolean(at) && now - new Date(at as string).getTime() < undoWindowSec * 1000,
    [now, undoWindowSec],
  );

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

  /**
   * Leave a stop — in two phases, because leaving one used to be the quietest
   * way to lose a child.
   *
   * The old version wrote `departed_at` and promoted whoever had boarded. A
   * student who tapped "I'm at the hub" and was never boarded simply stayed
   * `waiting` while the van pulled away, and NOTHING fired: the catch was End
   * trip, potentially forty minutes and eight stops later. That is worse than
   * the child who never checked in, because the app knew they were there.
   *
   * So the same question End trip asks is now asked here, where the van is still
   * at the kerb: does anyone at this stop have no outcome? If so the write is
   * held and they are listed with their buttons (the CLEARING step below) rather
   * than the driver being sent back up the screen to find them.
   *
   * The driver is never stuck. `force` leaves anyway — a van that cannot move is
   * its own safety problem — and the database takes it, because the flag is set.
   * It just stops being free: `record_forced_departure()` files an incident per
   * child and their parents and the office are told immediately, instead of
   * nobody being told at all.
   */
  async function departStop(stopId: string, opts: { skipped?: boolean; force?: boolean } = {}) {
    const unresolved = unresolvedAtStop(riders, stopId);
    if (unresolved.length && !opts.force) {
      setBlockedStop(stopId);
      return;
    }

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
        {
          trip_id: id,
          stop_id: stopId,
          departed_at: new Date().toISOString(),
          // Never inferred from a null arrival: "deliberately skipped" and "the
          // arrival was never recorded" are different facts about a child.
          skipped: Boolean(opts.skipped),
          departed_with_unresolved: unresolved.length > 0,
        },
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
    setBlockedStop(null);
    await reload();
  }

  function confirmLeaveAnyway(stopId: string, unresolved: StudentTripStatus[], where: string) {
    Alert.alert(
      `Leave ${where} without ${unresolved.length === 1 ? 'them' : 'all of them'}?`,
      `${unresolved
        .map((r) => `• ${nameOf(r.student_id)} — ${RIDER_STATUS_LABEL[r.status]}`)
        .join('\n')}\n\nYou can always keep driving. This records an incident for each of them, and tells their parents and the transport office right now.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave anyway',
          style: 'destructive',
          onPress: () => departStop(stopId, { force: true }),
        },
      ],
    );
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
      return false;
    }
    await reload();
    return true;
  }

  const runAction = (row: StudentTripStatus, status: RiderStatus) =>
    status === 'unable_to_drop_off' ? confirmUnableToDrop(row) : setStatus(row, status);

  /**
   * Take back the last tap on a student.
   *
   * A mistapped `no_show` used to be TERMINAL — the card rendered with no
   * actions at all and the only way out was a coordinator, mid-route, from a
   * desk. The server reads the previous status out of the audit log and writes a
   * COMPENSATING entry, so the record reads "this happened, then it was taken
   * back" rather than quietly ceasing to mention it.
   */
  async function undoRider(row: StudentTripStatus) {
    setError('');
    setBusyId(row.id);
    const { error: e } = await supabase.rpc('undo_rider_status', { row_id: row.id });
    setBusyId(null);
    if (e) return setError(e.message);
    await reload();
  }

  /** Same, for the last arrive/depart tap on a stop. */
  async function undoStop(stopId: string) {
    setError('');
    setBusyStop(stopId);
    const { error: e } = await supabase.rpc('undo_stop_progress', {
      target_trip: id,
      target_stop: stopId,
    });
    setBusyStop(null);
    if (e) return setError(e.message);
    setBlockedStop(null);
    await reload();
  }

  /**
   * Board a student the record says is not travelling today.
   *
   * `absent`, `parent_pickup` and `no_show` are all final, so the boarding
   * buttons are gone — which is right until the child is standing at the door.
   * Then the driver has no way to record what is plainly happening, takes them
   * anyway (of course they do), and the van is officially not carrying a child it
   * is carrying. The fix is not to prevent it; it is to make it recordable.
   *
   * The note is not optional, and not only because this screen says so:
   * `guard_boarding_after_away()` refuses the write without one. It reaches the
   * parents and the transport office in the same minute, because the absence
   * this contradicts is something the office is holding a request for.
   */
  async function boardAnyway(row: StudentTripStatus) {
    const note = turnUpNote.trim();
    if (!note) {
      Alert.alert(
        'Say what happened',
        'Boarding a student who is marked as not travelling needs a note. It goes to their parents and the transport office.',
      );
      return;
    }
    if (await setStatus(row, 'boarded', note)) {
      setTurnUpId(null);
      setTurnUpNote('');
    }
  }

  /**
   * Drop off everyone still on board at this stop, in one write.
   *
   * The morning arrival at school is what this exists for: a whole van of
   * children get off in the same place at the same moment, and tapping them off
   * one at a time is up to thirty taps carrying no information — which trains
   * exactly the rapid tap-through that would make the AFTERNOON's per-child
   * confirmations unreliable, and those do carry information.
   *
   * Exceptions are marked FIRST, and this covers who is left. Anyone the driver
   * has already recorded as unable to drop off is excluded by construction (they
   * are no longer onboard-at-this-stop), and the count on the button falls as
   * they do it. So the record says who did not get off, instead of asserting
   * that everyone did — which is the whole reason a single end-of-route tap was
   * the wrong shape.
   *
   * Every rider still gets their own row and their own notification. This is one
   * write, not one outcome: the timestamp they share is the moment the doors
   * actually opened, which is true for all of them.
   */
  async function dropAllAt(stopId: string, ids: string[]) {
    if (!ids.length) return;

    setBusyStop(stopId);
    setError('');

    const now = new Date().toISOString();
    const { error: e } = await supabase
      .from('student_trip_status')
      .update({ status: 'dropped_off', dropoff_time: now, updated_by: me, updated_at: now })
      .in('id', ids);

    setBusyStop(null);
    if (e) return setError(e.message);
    await reload();
  }

  function confirmDropAll(stopId: string, ids: string[], where: string) {
    Alert.alert(
      `Drop off ${ids.length} students?`,
      `This records all ${ids.length} as dropped off safely at ${where}, and tells their parents.\n\nIf anyone did NOT get off here, cancel and mark them first — then this button covers whoever is left.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: `Yes, all ${ids.length} are off`, onPress: () => dropAllAt(stopId, ids) },
      ],
    );
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
    if (e) {
      setError(e.message);
      return;
    }
    await reload();
    await beginTracking(trip.vehicle_id, trip.id);
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

    // The route is over: stop following the driver. Tracking exists to show the
    // van to the families riding it, not to know where the driver goes next.
    await stopTracking();
    setTrackingState('off');
    setTrackingNote('');

    await reload();
    Alert.alert('Trip completed', 'Every student has a final status.');
    router.back();
  }

  /**
   * Say the van is running late, in minutes rather than in prose.
   *
   * Cumulative on the server: twenty minutes of traffic followed by another ten
   * is thirty, because the driver is reporting what just happened, not restating
   * a running total they would have to remember.
   */
  async function reportDelay(minutes: number) {
    if (!trip) return;
    setError('');
    setDelaying(true);
    const { error: e } = await supabase.rpc('report_delay', {
      target_trip: trip.id,
      minutes,
      reason: incidentNote.trim() || null,
    });
    setDelaying(false);
    if (e) return setError(e.message);
    setIncidentNote('');
    await reload();
    Alert.alert('Families told', `Every remaining stop on this route moved by ${minutes} minutes.`);
  }

  /**
   * Find out whose van a child in front of you actually belongs on.
   *
   * RLS means a driver cannot see a student who is not on their trip — which is
   * correct, and which is exactly why a child boarding the wrong van was
   * invisible to everybody: a no-show on one van and a non-person on the other.
   * The server answers with a name, a route, a driver and a hub, and nothing
   * else.
   */
  async function lookupRider() {
    setError('');
    setLookupBusy(true);
    const { data, error: e } = await supabase.rpc('find_rider_today', { search: lookupName });
    setLookupBusy(false);
    if (e) {
      setError(e.message);
      setLookupHits(null);
      return;
    }
    setLookupHits((data as RiderLookup[]) ?? []);
  }

  /** Board a rider of THIS trip at a stop that is not the one they are assigned. */
  async function boardAtThisStop() {
    if (!wrongStopFor) return;
    const note = wrongStopNote.trim();
    if (!note) {
      Alert.alert('Say what happened', 'Boarding a student at a stop that is not theirs needs a note.');
      return;
    }
    setError('');
    setBusyId(wrongStopFor.rowId);
    const { error: e } = await supabase.rpc('board_at_other_stop', {
      status_id: wrongStopFor.rowId,
      actual_stop: wrongStopFor.stopId,
      reason: note,
    });
    setBusyId(null);
    if (e) return setError(e.message);
    setWrongStopFor(null);
    setWrongStopNote('');
    await reload();
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

        // Who is still on board to be let off here. Drives the batch drop-off.
        const toDropHere = atStop.filter(
          (r) =>
            r.dropoff_stop_id === stop.id &&
            ['boarded', 'in_transit'].includes(r.status),
        );

        // In scan mode the driver does not board anybody — the students scan the
        // card in the van and the roster fills in underneath. What the driver
        // needs is the COUNT, live, so they can see it settle and know when to
        // pull away. Shown while the van is standing here with people still to
        // get on.
        const scanning = attendanceMode === 'scan' && active && arrived && !departed;
        const aboardHere = atStop.filter(
          (r) => r.pickup_stop_id === stop.id && ['boarded', 'in_transit'].includes(r.status),
        ).length;
        const dueHere = atStop.filter((r) => r.pickup_stop_id === stop.id && !isAway(r.status)).length;

        // Two or more people getting off in the same place at the same moment is
        // the case worth batching — overwhelmingly the morning arrival at school.
        const canDropAll = active && arrived && toDropHere.length >= 2;

        // Everyone here the van would be leaving behind with no outcome. Held
        // against the SAME rule the database enforces, so the list the driver
        // sees is exactly the list the write would be refused on.
        const unresolvedHere = unresolvedAtStop(riders, stop.id);
        const clearing = blockedStop === stop.id;

        // Riders on this van who are still to board, but at a DIFFERENT stop.
        // These are the ones who can turn up here by mistake.
        const elsewhere = riders.filter(
          (r) =>
            r.pickup_stop_id !== stop.id &&
            r.pickup_stop_id != null &&
            !isFinal(r.status) &&
            !['boarded', 'in_transit'].includes(r.status),
        );

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
                      : prog?.skipped
                        ? 'Skipped — nobody was due here'
                        : reachable
                          ? 'Van is due here next'
                          : 'Not reached yet'}
                  {prog?.departed_at
                    ? ` · Departed ${fmtTime(prog.departed_at)}`
                    : isDestination
                      ? ' · final stop'
                      : ''}
                </Text>
                {prog?.departed_with_unresolved ? (
                  <Text style={styles.warnLine}>
                    ⚠ Left with students unaccounted for. The transport office and their parents
                    were told.
                  </Text>
                ) : null}
                {/* The way back from a mistap, for as long as it is still a mistap. */}
                {active && (undoable(prog?.departed_at) || undoable(prog?.arrived_at)) ? (
                  <Button
                    label={prog?.departed_at ? 'Undo — I have not left yet' : 'Undo — not here yet'}
                    variant="ghost"
                    loading={busyStop === stop.id}
                    onPress={() => undoStop(stop.id)}
                  />
                ) : null}
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
                        label={
                          allAway && !arrived
                            ? 'Skip this stop'
                            : unresolvedHere.length
                              ? `Departed this stop — ${unresolvedHere.length} to settle`
                              : 'Departed this stop'
                        }
                        loading={busyStop === stop.id}
                        style={styles.action}
                        onPress={() => departStop(stop.id, { skipped: allAway && !arrived })}
                      />
                    ) : null}
                  </Row>
                ) : null}
              </Card>
            ) : null}

            {/*
              The CLEARING step. The driver asked to leave and somebody here has
              no outcome, so the departure is held and they are listed HERE with
              their own buttons — the alternative is sending a driver holding a
              phone in a moving vehicle back up the screen to find them.

              "Leave anyway" is always available. What it is not is silent.
            */}
            {clearing ? (
              <Card style={styles.urgent}>
                {unresolvedHere.length ? (
                  <>
                    <Text style={styles.urgentTitle}>
                      {unresolvedHere.length === 1
                        ? '1 student here has no outcome'
                        : `${unresolvedHere.length} students here have no outcome`}
                    </Text>
                    <Text style={styles.urgentBody}>
                      Settle each one before you pull away — or leave anyway, which tells their
                      parents and the transport office right now.
                    </Text>

                    {unresolvedHere.map((row) => {
                      const boardingHere = row.pickup_stop_id === stop.id;
                      return (
                        <View key={row.id} style={styles.clearRow}>
                          <Row style={styles.between}>
                            <View style={styles.grow}>
                              <Text style={styles.studentName}>{nameOf(row.student_id)}</Text>
                              <Text style={styles.fine}>
                                {boardingHere
                                  ? row.check_in_time
                                    ? `Checked in ${fmtTime(row.check_in_time)} — they said they were here`
                                    : 'Never checked in'
                                  : row.board_time
                                    ? `On board since ${fmtTime(row.board_time)} — due off here`
                                    : 'Due off here'}
                              </Text>
                            </View>
                            <Badge
                              label={RIDER_STATUS_LABEL[row.status]}
                              tone={RIDER_STATUS_TONE[row.status]}
                            />
                          </Row>
                          <Row style={styles.wrap}>
                            {(boardingHere ? ACTIONS : DROP_ACTIONS).map((a) => (
                              <Button
                                key={a.status}
                                label={a.label}
                                variant={a.variant}
                                loading={busyId === row.id}
                                style={styles.action}
                                onPress={() => runAction(row, a.status)}
                              />
                            ))}
                          </Row>
                        </View>
                      );
                    })}

                    <Button
                      label="Leave anyway"
                      variant="danger"
                      loading={busyStop === stop.id}
                      onPress={() =>
                        confirmLeaveAnyway(
                          stop.id,
                          unresolvedHere,
                          ref.stopName(stop.id) ?? 'this stop',
                        )
                      }
                    />
                    <Button label="Not yet" variant="ghost" onPress={() => setBlockedStop(null)} />
                  </>
                ) : (
                  <>
                    <Text style={styles.batchTitle}>Everyone here has an outcome.</Text>
                    <Button
                      label="Departed this stop"
                      loading={busyStop === stop.id}
                      onPress={() => departStop(stop.id)}
                    />
                  </>
                )}
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

            {/*
              The headcount, when the office runs scan mode.

              This is the driver's whole job at a pickup stop now: watch the
              number go up, and pull away when it stops. It is deliberately a
              count and not a list — a driver looking at eleven names is reading,
              and a driver looking at "9 of 11 aboard" is checking.

              It is also the thing that ratifies the scans. A self-scan is not a
              driver observation; this is where a human confirms the van holds
              who the app says it holds, and the departure below still refuses to
              go while anyone here has no outcome.
            */}
            {scanning && dueHere > 0 ? (
              <Card style={styles.batch}>
                <Text style={styles.batchTitle}>
                  {aboardHere} of {dueHere} aboard {isOrigin ? 'at school' : 'here'}
                </Text>
                <Text style={styles.fine}>
                  {aboardHere === dueHere
                    ? 'Everyone due here has scanned on. Check the van matches, then depart.'
                    : `${dueHere - aboardHere} still to scan. They tap “Scan to board” and point their phone at the card by the door — the buttons on each student below still work if a phone is flat.`}
                </Text>
              </Card>
            ) : null}

            {/*
              C7: a child on this van, waiting at a hub that is not theirs.

              Their card only renders under their OWN stop, so before this there
              was no way to board them here at all — the scanner refused and the
              buttons were on a card further down the screen that did not apply.
              Recording it as what it is beats the driver taking them and the
              record saying they were never picked up.
            */}
            {active && arrived && !departed && elsewhere.length > 0 ? (
              <Card style={styles.progressCard}>
                {wrongStopFor?.stopId === stop.id ? (
                  <>
                    <Text style={styles.batchTitle}>
                      Boarding {nameOf(
                        riders.find((r) => r.id === wrongStopFor.rowId)?.student_id ?? '',
                      )} here
                    </Text>
                    <Field
                      label="Why are they at this stop? (required)"
                      value={wrongStopNote}
                      onChangeText={setWrongStopNote}
                      placeholder="Walked to this hub instead — mum dropped her here."
                      multiline
                      numberOfLines={2}
                      style={styles.textarea}
                    />
                    <Row style={styles.wrap}>
                      <Button
                        label="Board them here"
                        loading={busyId === wrongStopFor.rowId}
                        style={styles.action}
                        onPress={boardAtThisStop}
                      />
                      <Button
                        label="Cancel"
                        variant="ghost"
                        style={styles.action}
                        onPress={() => {
                          setWrongStopFor(null);
                          setWrongStopNote('');
                        }}
                      />
                    </Row>
                  </>
                ) : (
                  <>
                    <Text style={styles.fine}>
                      Someone here who normally uses another hub? Board them at this stop and the
                      record will say so.
                    </Text>
                    <Row style={styles.wrap}>
                      {elsewhere.map((r) => (
                        <Button
                          key={r.id}
                          label={`${nameOf(r.student_id)} — boarding here instead`}
                          variant="secondary"
                          style={styles.action}
                          onPress={() => {
                            setWrongStopFor({ rowId: r.id, stopId: stop.id });
                            setWrongStopNote('');
                          }}
                        />
                      ))}
                    </Row>
                  </>
                )}
              </Card>
            ) : null}

            {/* One tap for everyone getting off here — mark the exceptions first. */}
            {canDropAll ? (
              <Card style={styles.batch}>
                <Text style={styles.batchTitle}>
                  {toDropHere.length} still on board for {ref.stopName(stop.id) ?? 'this stop'}
                </Text>
                <Button
                  label={`All ${toDropHere.length} dropped off safely`}
                  loading={busyStop === stop.id}
                  style={styles.action}
                  onPress={() =>
                    confirmDropAll(
                      stop.id,
                      toDropHere.map((r) => r.id),
                      ref.stopName(stop.id) ?? 'this stop',
                    )
                  }
                />
                <Text style={styles.fine}>
                  Anyone who did NOT get off — mark them below first, and this covers whoever is
                  left. Each student still gets their own record and their parents still get told.
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
              // The child the record says is not travelling, standing at the
              // door. `done` is true for all three away statuses, so the normal
              // buttons are gone — this is the way back in.
              const showTurnedUp = trip.status === 'active' && isPickupStop && isAway(row.status);
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
                          onPress={() => runAction(row, a.status)}
                        />
                      ))}
                    </Row>
                  ) : showTurnedUp ? (
                    turnUpId === row.id ? (
                      <>
                        <Field
                          label="What happened? (required)"
                          value={turnUpNote}
                          onChangeText={setTurnUpNote}
                          placeholder="Mum brought her to the hub after all."
                          multiline
                          numberOfLines={2}
                          style={styles.textarea}
                        />
                        <Row style={styles.wrap}>
                          <Button
                            label="Board them"
                            loading={busyId === row.id}
                            style={styles.action}
                            onPress={() => boardAnyway(row)}
                          />
                          <Button
                            label="Cancel"
                            variant="ghost"
                            style={styles.action}
                            onPress={() => {
                              setTurnUpId(null);
                              setTurnUpNote('');
                            }}
                          />
                        </Row>
                        <Text style={styles.fine}>
                          Their parents and the transport office are told immediately, with your
                          note — someone is expecting this child not to be on the van.
                        </Text>
                      </>
                    ) : (
                      <Button
                        label="Boarding anyway — turned up"
                        variant="secondary"
                        style={styles.action}
                        onPress={() => {
                          setTurnUpId(row.id);
                          setTurnUpNote('');
                        }}
                      />
                    )
                  ) : null}

                  {/*
                    Undo the last tap on THIS student, for a few seconds after it.

                    Deliberately separate from the buttons above: those record
                    what happened, this says the last one did not. It disappears
                    on its own, because offering an undo the database will refuse
                    is worse than not offering one.
                  */}
                  {trip.status === 'active' && undoable(row.updated_at) ? (
                    <Button
                      label={`Undo — not ${RIDER_STATUS_LABEL[row.status].toLowerCase()}`}
                      variant="ghost"
                      loading={busyId === row.id}
                      onPress={() => undoRider(row)}
                    />
                  ) : null}
                </Card>
              );
            })}
          </View>
        );
      })}

      {riders.length === 0 ? <Empty>No students on this trip.</Empty> : null}

      {/*
        C7, manual mode. Scan mode can already name a child holding a code for
        another van; typing a name is the same answer without a phone in the
        child's hand.

        Without this, a child boarding the wrong van is invisible to everybody:
        RLS means this driver cannot see them, so they are a no-show on one van
        and do not exist on the other, and nobody is told by anybody.
      */}
      {trip.status === 'active' ? (
        <>
          <SectionLabel>Someone here isn’t on your list?</SectionLabel>
          <Card>
            {!lookupOpen ? (
              <>
                <Text style={styles.fine}>
                  Find out whose van they should be on before you drive away. You will see their
                  route, their driver and their hub — nothing else.
                </Text>
                <Button
                  label="Look up a student"
                  variant="secondary"
                  onPress={() => {
                    setLookupOpen(true);
                    setLookupHits(null);
                    setLookupName('');
                  }}
                />
              </>
            ) : (
              <>
                <Field
                  label="Their name"
                  value={lookupName}
                  onChangeText={setLookupName}
                  placeholder="Priya"
                  autoCapitalize="words"
                />
                <Row style={styles.wrap}>
                  <Button
                    label="Search"
                    loading={lookupBusy}
                    style={styles.action}
                    onPress={lookupRider}
                  />
                  <Button
                    label="Close"
                    variant="ghost"
                    style={styles.action}
                    onPress={() => {
                      setLookupOpen(false);
                      setLookupHits(null);
                    }}
                  />
                </Row>

                {lookupHits?.length === 0 ? (
                  <Text style={styles.warnLine}>
                    Nobody by that name is riding today. Call the office before you carry them.
                  </Text>
                ) : null}

                {lookupHits?.map((hit) => (
                  <Card key={hit.status_id} style={hit.is_mine ? styles.batch : styles.urgent}>
                    <Text style={styles.studentName}>{hit.student_name}</Text>
                    {hit.is_mine ? (
                      <Text style={styles.fine}>
                        On your van — {ROUTE_TYPE_LABEL[hit.route_kind]}, boards at {hit.hub_name}.
                        Currently {RIDER_STATUS_LABEL[hit.rider_status].toLowerCase()}. Use their
                        card above.
                      </Text>
                    ) : (
                      <Text style={styles.urgentBody}>
                        Rides {hit.route_name} with {hit.driver_name}, from {hit.hub_name} — not
                        this van. Do not carry them; call the office so they can move them across.
                      </Text>
                    )}
                  </Card>
                ))}
              </>
            )}
          </Card>
        </>
      ) : null}

      {/*
        S1: a STRUCTURED delay, not a free-text incident.

        `delay_minutes` and `delay_reason` have been on daily_trips since the
        first schema and nothing has ever written them. The only delay path was
        an incident, which notifies parents and then shifts nothing — every
        planned time in the app carried on as if the van were on schedule, and
        the "due in 15 minutes" alerts kept firing confidently wrong.
      */}
      {trip.status === 'active' ? (
        <>
          <SectionLabel>Running late?</SectionLabel>
          <Card>
            <Text style={styles.fine}>
              This moves every remaining expected time on this route and tells the families the new
              one. It is not the same as reporting an incident — use this for traffic.
            </Text>
            {trip.delay_minutes ? (
              <Text style={styles.warnLine}>
                Already reported {trip.delay_minutes} minutes late
                {trip.delay_reason ? ` — ${trip.delay_reason}` : ''}. Adding more is cumulative.
              </Text>
            ) : null}
            <Row style={styles.wrap}>
              {[10, 15, 30].map((m) => (
                <Button
                  key={m}
                  label={`+${m} min`}
                  variant="secondary"
                  loading={delaying}
                  style={styles.action}
                  onPress={() => reportDelay(m)}
                />
              ))}
            </Row>
            <Text style={styles.fine}>
              Anything you have typed in “What happened?” below is sent as the reason.
            </Text>
          </Card>
        </>
      ) : null}

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

      <SectionLabel>Van position</SectionLabel>
      {!gpsEnabled ? (
        <GpsDisabled compact />
      ) : !trip.vehicle_id ? (
        <Card>
          <Text style={styles.fine}>
            No vehicle is assigned to this trip, so there is nothing to report a position for. Ask
            the transport office to assign one.
          </Text>
        </Card>
      ) : trip.status !== 'active' ? (
        <Card>
          <Text style={styles.fine}>
            The van starts sharing its position when you start the trip and stops when you end it.
            Your phone is not sharing anything right now.
          </Text>
        </Card>
      ) : (
        <Card>
          <Row style={styles.between}>
            <Text style={styles.trackingTitle}>
              {trackingState === 'background'
                ? '🛰️ Sharing position'
                : trackingState === 'foreground'
                  ? '⚠️ Sharing only on this screen'
                  : '⚠️ Not sharing position'}
            </Text>
            <Badge
              label={trackingState === 'background' ? 'Live' : trackingState === 'foreground' ? 'Limited' : 'Off'}
              tone={trackingState === 'background' ? 'success' : trackingState === 'foreground' ? 'warn' : 'danger'}
            />
          </Row>
          <Text style={styles.fine}>
            {trackingState === 'background'
              ? 'Students and parents on this route can see the van. It stops the moment you end the trip — and stops itself if you forget.'
              : trackingNote ||
                'The van is not reporting its position, so the map is empty for every family on this route.'}
          </Text>
          {trackingState === 'background' ? (
            <Text style={styles.fine}>
              Only while a route is running, and only this van's position — never you off-shift. A
              parked van reports about once a minute instead of continuously.
            </Text>
          ) : null}
          {trackingState !== 'background' ? (
            <Button
              label="Try again"
              variant="secondary"
              onPress={() => beginTracking(trip.vehicle_id, trip.id)}
            />
          ) : null}
        </Card>
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
  batch: { gap: 10, borderColor: theme.accent },
  batchTitle: { fontSize: 15, fontWeight: '700', color: theme.text },
  trackingTitle: { fontSize: 15, fontWeight: '700', color: theme.text, flexShrink: 1 },
  skip: { backgroundColor: theme.surfaceAlt },
  skipText: { fontSize: 13, color: theme.muted },
  urgent: { borderColor: theme.danger, backgroundColor: '#2A1D1D' },
  urgentTitle: { fontSize: 15, fontWeight: '700', color: theme.danger },
  urgentBody: { fontSize: 13, color: theme.text, lineHeight: 19 },
  warnLine: { fontSize: 12, color: theme.warn, lineHeight: 17 },
  clearRow: { gap: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.border },
  textarea: { minHeight: 76, textAlignVertical: 'top', paddingTop: 12 },
});
