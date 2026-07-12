import { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../src/lib/auth';
import { supabase } from '../../src/lib/supabase';
import {
  ensureTodaysTrips,
  today,
  useReference,
  useTripStatuses,
} from '../../src/lib/hooks';
import {
  RIDER_STATUS_LABEL,
  RIDER_STATUS_TONE,
  ROUTE_TYPE_LABEL,
  isFinal,
} from '../../src/lib/types';
import type { Profile } from '../../src/lib/types';
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
} from '../../src/components/ui';

/**
 * Coordinator dashboard (blueprint §5.2): summary cards, the trip board,
 * assignments, communication, and the daily closeout.
 */
export default function StaffDashboard() {
  const { profile, signOut, lockStaff } = useAuth();
  const ref = useReference();
  const { rows, trips, loading, reload } = useTripStatuses();

  const [drivers, setDrivers] = useState<Profile[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadDrivers = useCallback(async () => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('role', 'driver')
      .eq('status', 'active')
      .order('full_name');
    setDrivers((data as Profile[]) ?? []);
  }, []);

  useEffect(() => {
    ensureTodaysTrips().then(reload);
    loadDrivers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function assignDriver(tripId: string, driverId: string | null) {
    // Blueprint §5.2: a driver can be replaced BEFORE the trip starts.
    const { error: e } = await supabase
      .from('daily_trips')
      .update({ driver_id: driverId })
      .eq('id', tripId);
    if (e) setError(e.message);
    await reload();
  }

  async function announce() {
    if (!profile) return;
    setBusy(true);
    setError('');

    const { error: e } = await supabase
      .from('announcements')
      .insert({ title: title.trim(), body: body.trim(), created_by: profile.id });

    if (e) {
      setError(e.message);
      setBusy(false);
      return;
    }

    // Announcements also become notifications so they push.
    const { data: everyone } = await supabase
      .from('profiles')
      .select('id')
      .eq('status', 'active')
      .in('role', ['student', 'parent', 'driver']);

    const people = (everyone as { id: string }[]) ?? [];
    if (people.length) {
      await supabase.from('notifications').insert(
        people.map((p) => ({
          user_id: p.id,
          title: title.trim(),
          body: body.trim(),
          kind: 'announcement',
        })),
      );
    }

    setTitle('');
    setBody('');
    setBusy(false);
    Alert.alert('Sent', `Announced to ${people.length} people.`);
  }

  if (loading || ref.loading) return <Loading />;

  // Blueprint §5.2 summary cards.
  const activeTrips = trips.filter((t) => t.status === 'active').length;
  const waiting = rows.filter((r) => r.status === 'waiting').length;
  const onboard = rows.filter((r) => ['boarded', 'in_transit'].includes(r.status)).length;
  const unresolved = rows.filter(
    (r) => !isFinal(r.status) && !['scheduled'].includes(r.status),
  ).length;
  const urgent = rows.filter((r) => r.status === 'unable_to_drop_off').length;

  // Daily closeout: every trip complete and every student with a final status.
  const allTripsDone = trips.length > 0 && trips.every((t) => ['completed', 'cancelled'].includes(t.status));
  const allStudentsDone = rows.every((r) => isFinal(r.status));

  return (
    <Screen>
      <Title sub={`${today()} · ${profile?.role}`}>Dashboard</Title>

      <Row style={styles.cards}>
        <Stat label="Active trips" value={activeTrips} tone={theme.accent} />
        <Stat label="Waiting" value={waiting} tone={theme.warn} />
        <Stat label="Onboard" value={onboard} tone={theme.accent} />
      </Row>
      <Row style={styles.cards}>
        <Stat label="Unresolved" value={unresolved} tone={unresolved ? theme.warn : theme.muted} />
        <Stat label="Urgent" value={urgent} tone={urgent ? theme.danger : theme.muted} />
        <Stat label="Trips today" value={trips.length} tone={theme.muted} />
      </Row>

      {urgent > 0 ? (
        <Card style={styles.urgent}>
          <Text style={styles.urgentTitle}>⚠ {urgent} student(s) could not be dropped off</Text>
          <Text style={styles.urgentBody}>
            They are still on a vehicle. Open the Exceptions tab — a trip cannot close until you
            resolve this.
          </Text>
        </Card>
      ) : null}

      <ErrorText>{error}</ErrorText>

      <SectionLabel>Trip board</SectionLabel>

      {trips.length === 0 ? (
        <Empty>
          No trips today. Either no route runs on this weekday, or no route templates exist yet.
        </Empty>
      ) : null}

      {trips.map((trip) => {
        const route = ref.routeOf(trip.route_id);
        const vehicle = ref.vehicleOf(trip.vehicle_id);
        const riders = rows.filter((r) => r.trip_id === trip.id);
        const done = riders.filter((r) => isFinal(r.status)).length;
        const travelling = riders.filter((r) => !['absent', 'parent_pickup'].includes(r.status));
        const over = vehicle ? travelling.length > vehicle.capacity : false;
        const driver = drivers.find((d) => d.id === trip.driver_id);

        return (
          <Card key={trip.id}>
            <Row style={styles.between}>
              <View style={styles.grow}>
                <Text style={styles.name}>
                  {route?.name} · {route ? ROUTE_TYPE_LABEL[route.type] : ''}
                </Text>
                <Text style={styles.fine}>
                  {vehicle?.label ?? 'No vehicle'} · {driver?.full_name ?? 'NO DRIVER'} · {done}/
                  {riders.length} resolved
                </Text>
              </View>
              <Badge
                label={
                  trip.status === 'active'
                    ? 'Running'
                    : trip.status === 'completed'
                      ? 'Done'
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

            {over ? (
              <Text style={styles.warn}>
                ⚠ Over capacity — {travelling.length} students, {vehicle?.label} seats{' '}
                {vehicle?.capacity}.
              </Text>
            ) : null}

            {!trip.driver_id ? (
              <Text style={styles.warn}>⚠ No driver assigned. This trip cannot run.</Text>
            ) : null}

            {/* Blueprint §5.2: replace a driver BEFORE the trip starts. */}
            {trip.status === 'scheduled' ? (
              <>
                <Text style={styles.fine}>Assign a driver:</Text>
                <Row style={styles.wrap}>
                  {drivers.length === 0 ? (
                    <Text style={styles.fine}>No approved drivers yet.</Text>
                  ) : (
                    drivers.map((d) => (
                      <Button
                        key={d.id}
                        label={d.full_name.split(' ')[0]}
                        variant={trip.driver_id === d.id ? 'primary' : 'secondary'}
                        onPress={() =>
                          assignDriver(trip.id, trip.driver_id === d.id ? null : d.id)
                        }
                      />
                    ))
                  )}
                </Row>
              </>
            ) : null}

            {riders.length > 0 ? (
              <View style={styles.riders}>
                {riders.map((r) => (
                  <Badge
                    key={r.id}
                    label={RIDER_STATUS_LABEL[r.status]}
                    tone={RIDER_STATUS_TONE[r.status]}
                  />
                ))}
              </View>
            ) : null}
          </Card>
        );
      })}

      <SectionLabel>Daily closeout</SectionLabel>
      <Card>
        <Row style={styles.between}>
          <Text style={styles.fine}>All trips completed</Text>
          <Badge label={allTripsDone ? 'Yes' : 'No'} tone={allTripsDone ? 'success' : 'warn'} />
        </Row>
        <Row style={styles.between}>
          <Text style={styles.fine}>Every student has a final status</Text>
          <Badge
            label={allStudentsDone ? 'Yes' : 'No'}
            tone={allStudentsDone ? 'success' : 'warn'}
          />
        </Row>
        <Text style={styles.fine}>
          Blueprint §1.3: the day is not done until every student on every route ends with a final
          status.
        </Text>
      </Card>

      <SectionLabel>Send an announcement</SectionLabel>
      <Card>
        <Field label="Title" value={title} onChangeText={setTitle} placeholder="No service Friday" />
        <Field
          label="Message"
          value={body}
          onChangeText={setBody}
          placeholder="The vans will not run on Friday due to the staff day."
          multiline
          numberOfLines={3}
          style={styles.textarea}
        />
        <Button
          label="Send to everyone"
          onPress={announce}
          loading={busy}
          disabled={!title.trim() || !body.trim()}
        />
      </Card>

      <Row>
        <Button label="Lock portal" variant="secondary" onPress={lockStaff} style={styles.grow} />
        <Button label="Sign out" variant="ghost" onPress={signOut} style={styles.grow} />
      </Row>
    </Screen>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <Card style={styles.stat}>
      <Text style={[styles.statValue, { color: tone }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  cards: { gap: 10 },
  stat: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 14 },
  statValue: { fontSize: 24, fontWeight: '700' },
  statLabel: { fontSize: 11, color: theme.faint, textAlign: 'center' },
  between: { justifyContent: 'space-between' },
  grow: { flex: 1 },
  wrap: { flexWrap: 'wrap' },
  name: { fontSize: 15, fontWeight: '700', color: theme.text },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  warn: { fontSize: 12, color: theme.warn, lineHeight: 17 },
  riders: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  urgent: { borderColor: theme.danger, backgroundColor: '#2A1D1D' },
  urgentTitle: { fontSize: 15, fontWeight: '700', color: theme.danger },
  urgentBody: { fontSize: 13, color: theme.text, lineHeight: 19 },
  textarea: { minHeight: 76, textAlignVertical: 'top', paddingTop: 12 },
});
