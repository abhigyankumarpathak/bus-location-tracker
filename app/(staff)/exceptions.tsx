import { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../src/lib/auth';
import { supabase } from '../../src/lib/supabase';
import { useReference, useTripStatuses } from '../../src/lib/hooks';
import {
  CHANGE_LABEL,
  RIDER_STATUS_LABEL,
  RIDER_STATUS_TONE,
  isFinal,
} from '../../src/lib/types';
import type { ChangeRequest, Incident, Profile, RiderStatus, StudentTripStatus } from '../../src/lib/types';
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
 * The exception queue (blueprint §5.2 / §6.3).
 *
 * Everything that needs a human: late change requests, students the driver
 * could not drop off, no-shows, students still unaccounted for, and open
 * incidents.
 *
 * Overriding a driver's official record requires a reason (blueprint §2.1:
 * "Only coordinators and administrators may override an official status, and a
 * reason is required"). The reason is written to `note`, which the audit trigger
 * copies into audit_logs — so every override is attributable afterwards.
 */
const OVERRIDES: RiderStatus[] = [
  'dropped_off',
  'absent',
  'parent_pickup',
  'no_show',
  'waiting',
  'boarded',
];

export default function StaffExceptions() {
  const { profile } = useAuth();
  const ref = useReference();
  const { rows, trips, loading, reload } = useTripStatuses();

  const [requests, setRequests] = useState<ChangeRequest[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [people, setPeople] = useState<Profile[]>([]);
  const [error, setError] = useState('');

  const [overriding, setOverriding] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    const [{ data: cr }, { data: inc }, { data: pr }] = await Promise.all([
      supabase.from('change_requests').select('*').eq('approval', 'pending').order('created_at'),
      supabase.from('incidents').select('*').is('resolved_at', null).order('created_at', { ascending: false }),
      supabase.from('profiles').select('*'),
    ]);
    setRequests((cr as ChangeRequest[]) ?? []);
    setIncidents((inc as Incident[]) ?? []);
    setPeople((pr as Profile[]) ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const nameOf = (id: string | null) =>
    people.find((p) => p.id === id)?.full_name ?? 'Unknown';

  async function decide(request: ChangeRequest, approved: boolean) {
    setError('');
    const { error: e } = await supabase
      .from('change_requests')
      .update({
        approval: approved ? 'approved' : 'rejected',
        reviewed_by: profile?.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', request.id);

    if (e) {
      setError(e.message);
      return;
    }

    // Tell whoever asked.
    if (request.requested_by) {
      await supabase.from('notifications').insert({
        user_id: request.requested_by,
        title: approved ? 'Change approved' : 'Change not approved',
        body: `${CHANGE_LABEL[request.kind]} for ${request.date} was ${approved ? 'approved' : 'rejected'}.`,
        kind: 'approval',
      });
    }

    await load();
    await reload();
  }

  async function override(row: StudentTripStatus, status: RiderStatus) {
    if (!reason.trim()) {
      Alert.alert('Reason required', 'Overriding the driver’s record needs a reason. It is recorded in the audit log.');
      return;
    }
    setError('');

    const patch: Record<string, unknown> = {
      status,
      note: `Override by ${profile?.full_name}: ${reason.trim()}`,
      updated_by: profile?.id,
      updated_at: new Date().toISOString(),
    };
    if (status === 'dropped_off') patch.dropoff_time = new Date().toISOString();

    const { error: e } = await supabase.from('student_trip_status').update(patch).eq('id', row.id);

    if (e) {
      setError(e.message);
      return;
    }

    setOverriding(null);
    setReason('');
    await reload();
  }

  async function resolveIncident(id: string) {
    await supabase
      .from('incidents')
      .update({ resolved_at: new Date().toISOString(), resolved_by: profile?.id })
      .eq('id', id);
    await load();
  }

  if (loading || ref.loading) return <Loading />;

  const stuck = rows.filter((r) => r.status === 'unable_to_drop_off');
  const noShows = rows.filter((r) => r.status === 'no_show');
  // Students on a trip that already ran but who never got an outcome.
  const missing = rows.filter((r) => {
    const trip = trips.find((t) => t.id === r.trip_id);
    return trip?.status === 'active' && !isFinal(r.status) && r.status !== 'scheduled';
  });

  const nothing =
    !stuck.length && !noShows.length && !missing.length && !requests.length && !incidents.length;

  function renderRow(row: StudentTripStatus, tone: 'danger' | 'warn') {
    const trip = trips.find((t) => t.id === row.trip_id);
    const route = ref.routeOf(trip?.route_id);
    const open = overriding === row.id;

    return (
      <Card key={row.id} style={tone === 'danger' ? styles.urgent : undefined}>
        <Row style={styles.between}>
          <View style={styles.grow}>
            <Text style={styles.name}>{nameOf(row.student_id)}</Text>
            <Text style={styles.fine}>
              {route?.name} · {ref.stopName(row.dropoff_stop_id ?? row.pickup_stop_id) ?? 'No hub'}
            </Text>
            {row.note ? <Text style={styles.fine}>{row.note}</Text> : null}
          </View>
          <Badge label={RIDER_STATUS_LABEL[row.status]} tone={RIDER_STATUS_TONE[row.status]} />
        </Row>

        {open ? (
          <>
            <Field
              label="Reason for the override (required)"
              value={reason}
              onChangeText={setReason}
              placeholder="Spoke to the parent — collected at the school office."
              multiline
              numberOfLines={2}
              style={styles.textarea}
            />
            <Row style={styles.wrap}>
              {OVERRIDES.map((s) => (
                <Button
                  key={s}
                  label={RIDER_STATUS_LABEL[s]}
                  variant="secondary"
                  onPress={() => override(row, s)}
                />
              ))}
            </Row>
            <Button
              label="Cancel"
              variant="ghost"
              onPress={() => {
                setOverriding(null);
                setReason('');
              }}
            />
          </>
        ) : (
          <Button
            label="Resolve / override status"
            variant={tone === 'danger' ? 'danger' : 'secondary'}
            onPress={() => {
              setOverriding(row.id);
              setReason('');
            }}
          />
        )}
      </Card>
    );
  }

  return (
    <Screen>
      <Title sub="Everything that needs a person.">Exceptions</Title>

      <ErrorText>{error}</ErrorText>

      {nothing ? <Empty>Nothing outstanding. The day is clean.</Empty> : null}

      {stuck.length > 0 ? (
        <>
          <SectionLabel>Urgent — unable to drop off</SectionLabel>
          <Card style={styles.urgent}>
            <Text style={styles.urgentBody}>
              These students are still on a vehicle. The driver cannot close the trip until you
              resolve each one. Contact the parent and record what happened.
            </Text>
          </Card>
          {stuck.map((r) => renderRow(r, 'danger'))}
        </>
      ) : null}

      {requests.length > 0 ? (
        <>
          <SectionLabel>Late changes awaiting approval</SectionLabel>
          {requests.map((r) => (
            <Card key={r.id}>
              <Row style={styles.between}>
                <View style={styles.grow}>
                  <Text style={styles.name}>
                    {nameOf(r.student_id)} · {CHANGE_LABEL[r.kind]}
                  </Text>
                  <Text style={styles.fine}>
                    {r.date} · asked by {nameOf(r.requested_by)}
                    {r.reason ? ` · ${r.reason}` : ''}
                  </Text>
                </View>
                <Badge label="Pending" tone="warn" />
              </Row>
              <Text style={styles.fine}>
                Sent after the cutoff, so it needs your decision before it reaches the driver.
              </Text>
              <Row>
                <Button label="Approve" onPress={() => decide(r, true)} style={styles.grow} />
                <Button
                  label="Reject"
                  variant="danger"
                  onPress={() => decide(r, false)}
                  style={styles.grow}
                />
              </Row>
            </Card>
          ))}
        </>
      ) : null}

      {noShows.length > 0 ? (
        <>
          <SectionLabel>No-shows</SectionLabel>
          {noShows.map((r) => renderRow(r, 'warn'))}
        </>
      ) : null}

      {missing.length > 0 ? (
        <>
          <SectionLabel>Still unaccounted for</SectionLabel>
          {missing.map((r) => renderRow(r, 'warn'))}
        </>
      ) : null}

      {incidents.length > 0 ? (
        <>
          <SectionLabel>Open incidents</SectionLabel>
          {incidents.map((i) => (
            <Card key={i.id}>
              <Row style={styles.between}>
                <View style={styles.grow}>
                  <Text style={styles.name}>{i.kind}</Text>
                  <Text style={styles.fine}>
                    {nameOf(i.driver_id)} · {new Date(i.created_at).toLocaleString()}
                  </Text>
                </View>
                <Badge
                  label={i.severity}
                  tone={i.severity === 'high' ? 'danger' : i.severity === 'medium' ? 'warn' : 'neutral'}
                />
              </Row>
              {i.description ? <Text style={styles.body}>{i.description}</Text> : null}
              <Button label="Mark resolved" variant="secondary" onPress={() => resolveIncident(i.id)} />
            </Card>
          ))}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  between: { justifyContent: 'space-between' },
  grow: { flex: 1 },
  wrap: { flexWrap: 'wrap' },
  name: { fontSize: 15, fontWeight: '700', color: theme.text },
  body: { fontSize: 14, color: theme.muted, lineHeight: 20 },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  urgent: { borderColor: theme.danger },
  urgentBody: { fontSize: 13, color: theme.danger, lineHeight: 19 },
  textarea: { minHeight: 60, textAlignVertical: 'top', paddingTop: 12 },
});
