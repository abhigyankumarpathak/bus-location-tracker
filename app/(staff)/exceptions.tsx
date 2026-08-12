import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../src/lib/auth';
import { supabase } from '../../src/lib/supabase';
import { useReference, useTripStatuses } from '../../src/lib/hooks';
import {
  RIDER_STATUS_LABEL,
  RIDER_STATUS_TONE,
  WATCHDOG_LABEL,
  isFinal,
} from '../../src/lib/types';
import type {
  AppNotification,
  Incident,
  Profile,
  RiderStatus,
  StudentTripStatus,
  WatchdogAlert,
} from '../../src/lib/types';
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
 * Things that are WRONG. Not things that happened.
 *
 * This tab used to be everything — the feed, the approvals, the no-shows and the
 * emergencies in one scroll — which meant the emergencies were scrolled past.
 * The routine half now lives on Notifications, and what is left here is only the
 * work that means something has gone wrong and a person has to fix it.
 *
 * Ordered by how bad it is if nobody looks, not by when it arrived:
 *   1. a child on a van nobody can get off it
 *   2. a child who said they were at the hub and was then not picked up
 *   3. what the watchdog noticed that no human reported at all
 *   4. children with no outcome on a trip that has already run
 *   5. messages the system could not deliver
 *   6. open incidents
 *
 * Overriding a driver's record requires a reason (blueprint §2.1). The reason is
 * written to `note`, which the audit trigger copies into audit_logs — so every
 * override is attributable afterwards, and shows up on the History tab.
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

  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [alerts, setAlerts] = useState<WatchdogAlert[]>([]);
  const [undelivered, setUndelivered] = useState<AppNotification[]>([]);
  const [people, setPeople] = useState<Profile[]>([]);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  const [overriding, setOverriding] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    const [{ data: inc }, { data: wd }, { data: nd }, { data: pr }] = await Promise.all([
      supabase.from('incidents').select('*').is('resolved_at', null).order('created_at', { ascending: false }),
      supabase.from('watchdog_alerts').select('*').is('resolved_at', null).order('raised_at', { ascending: false }),
      // Messages the push path could not deliver. `no_token` is the common one:
      // that person has never opened the app on a phone that granted
      // notification permission, so they are unreachable and nobody knew.
      supabase
        .from('notifications')
        .select('*')
        .in('delivery_state', ['no_token', 'failed'])
        .gte('created_at', new Date(Date.now() - 7 * 86_400_000).toISOString())
        .order('created_at', { ascending: false })
        .limit(50),
      supabase.from('profiles').select('*'),
    ]);
    setIncidents((inc as Incident[]) ?? []);
    setAlerts((wd as WatchdogAlert[]) ?? []);
    setUndelivered((nd as AppNotification[]) ?? []);
    setPeople((pr as Profile[]) ?? []);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const nameOf = (id: string | null) => people.find((p) => p.id === id)?.full_name ?? 'Unknown';

  /**
   * Run the watchdog now rather than waiting up to five minutes for cron.
   *
   * Worth having as a button because the honest answer to "is anything wrong
   * right now?" should not depend on where you are in the cron cycle — and
   * because on a project where pg_cron was never enabled, this is the only way
   * it runs at all.
   */
  async function checkNow() {
    setChecking(true);
    setError('');
    const { error: e } = await supabase.rpc('transport_watchdog');
    setChecking(false);
    if (e) {
      setError(e.message);
      return;
    }
    await load();
  }

  async function resolveAlert(alert: WatchdogAlert) {
    setError('');
    const { error: e } = await supabase
      .from('watchdog_alerts')
      .update({
        resolved_at: new Date().toISOString(),
        resolved_by: profile?.id,
        resolution: `Acknowledged by ${profile?.full_name ?? 'the office'}.`,
      })
      .eq('id', alert.id);
    if (e) {
      setError(e.message);
      return;
    }
    await load();
  }

  async function override(row: StudentTripStatus, status: RiderStatus) {
    if (!reason.trim()) {
      Alert.alert(
        'Reason required',
        'Overriding the driver’s record needs a reason. It is recorded in the audit log.',
      );
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
  const checkedInNoShows = noShows.filter((r) => r.check_in_time);
  const plainNoShows = noShows.filter((r) => !r.check_in_time);
  // Students on a trip that already ran but who never got an outcome.
  const missing = rows.filter((r) => {
    const trip = trips.find((t) => t.id === r.trip_id);
    return trip?.status === 'active' && !isFinal(r.status) && r.status !== 'scheduled';
  });

  const nothing =
    !stuck.length &&
    !checkedInNoShows.length &&
    !plainNoShows.length &&
    !missing.length &&
    !incidents.length &&
    !alerts.length &&
    !undelivered.length;

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
      <Title sub="Only what has gone wrong. Everything else is on Notifications.">Exceptions</Title>

      <ErrorText>{error}</ErrorText>

      {nothing ? <Empty>Nothing is wrong. The day is clean.</Empty> : null}

      <Button
        label={checking ? 'Checking…' : 'Check for anything unreported'}
        variant="ghost"
        loading={checking}
        onPress={checkNow}
      />

      {stuck.length > 0 ? (
        <>
          <SectionLabel>Urgent — still on a vehicle</SectionLabel>
          <Card style={styles.urgent}>
            <Text style={styles.urgentBody}>
              The driver could not drop these students off, so they are still in the van. The trip
              cannot close until you resolve each one. Contact the parent and record what happened.
            </Text>
          </Card>
          {stuck.map((r) => renderRow(r, 'danger'))}
        </>
      ) : null}

      {checkedInNoShows.length > 0 ? (
        <>
          <SectionLabel>Checked in, then not picked up</SectionLabel>
          <Card style={styles.urgent}>
            <Text style={styles.urgentBody}>
              These students told the app they were at the hub, and the driver then recorded a
              no-show. Nobody knows where they are. Call the parent first.
            </Text>
          </Card>
          {checkedInNoShows.map((r) => renderRow(r, 'danger'))}
        </>
      ) : null}

      {/*
        The watchdog's own findings. These are the only items on this screen that
        NOBODY reported — every other section exists because a driver or a parent
        tapped something. If the coordinator is not watching a screen during the
        run, this section is the entire safety net.
      */}
      {alerts.length > 0 ? (
        <>
          <SectionLabel>Noticed by the watchdog — nobody reported these</SectionLabel>
          {alerts.map((a) => (
            <Card key={a.id} style={styles.urgent}>
              <Row style={styles.between}>
                <View style={styles.grow}>
                  <Text style={styles.name}>{WATCHDOG_LABEL[a.kind]}</Text>
                  <Text style={styles.fine}>
                    Raised{' '}
                    {new Date(a.raised_at).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </Text>
                </View>
                <Badge label="Unattended" tone="danger" />
              </Row>
              <Text style={styles.body}>{a.detail}</Text>
              <Button
                label="I have dealt with this"
                variant="secondary"
                onPress={() => resolveAlert(a)}
              />
            </Card>
          ))}
        </>
      ) : null}

      {missing.length > 0 ? (
        <>
          <SectionLabel>Still unaccounted for</SectionLabel>
          {missing.map((r) => renderRow(r, 'warn'))}
        </>
      ) : null}

      {plainNoShows.length > 0 ? (
        <>
          <SectionLabel>No-shows</SectionLabel>
          {plainNoShows.map((r) => renderRow(r, 'warn'))}
        </>
      ) : null}

      {/*
        Messages that never reached anybody. Before this was recorded, a family
        with no push token simply never heard anything and there was no trace of
        it — "we notified the parents" was unfalsifiable.
      */}
      {undelivered.length > 0 ? (
        <>
          <SectionLabel>Messages that were not delivered</SectionLabel>
          <Card style={styles.warnCard}>
            <Text style={styles.body}>
              These people are unreachable by push. Usually it means they have never opened the app
              on a phone that granted notification permission — so they are only seeing alerts if
              they happen to open the app.
            </Text>
          </Card>
          {undelivered.map((n) => (
            <Card key={n.id}>
              <Row style={styles.between}>
                <View style={styles.grow}>
                  <Text style={styles.name}>{nameOf(n.user_id)}</Text>
                  <Text style={styles.fine}>
                    “{n.title}” · {new Date(n.created_at).toLocaleString()}
                  </Text>
                </View>
                <Badge
                  label={n.delivery_state === 'no_token' ? 'No device' : 'Failed'}
                  tone={n.requires_ack ? 'danger' : 'warn'}
                />
              </Row>
              {n.delivery_detail ? <Text style={styles.fine}>{n.delivery_detail}</Text> : null}
              {n.requires_ack && !n.acknowledged_at ? (
                <Text style={styles.urgentBody}>
                  This one was urgent and has not been acknowledged. Phone them.
                </Text>
              ) : null}
            </Card>
          ))}
        </>
      ) : null}

      {incidents.length > 0 ? (
        <>
          <SectionLabel>Open incidents</SectionLabel>
          {incidents.map((i) => (
            <Card key={i.id}>
              <Row style={styles.between}>
                <View style={styles.grow}>
                  <Text style={styles.name}>
                    {i.kind}
                    {i.student_id ? ` · ${nameOf(i.student_id)}` : ''}
                  </Text>
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
  warnCard: { borderColor: theme.warn },
  urgentBody: { fontSize: 13, color: theme.danger, lineHeight: 19 },
  textarea: { minHeight: 60, textAlignVertical: 'top', paddingTop: 12 },
});
