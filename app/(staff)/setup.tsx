import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useAuth } from '../../src/lib/auth';
import { useOrg } from '../../src/lib/org';
import { supabase } from '../../src/lib/supabase';
import { useReference } from '../../src/lib/hooks';
import { ROUTE_TYPE_LABEL } from '../../src/lib/types';
import type { Profile, RouteAssignment, RouteStop } from '../../src/lib/types';
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

type Tab = 'routes' | 'hubs' | 'fleet' | 'features';

/**
 * Configuration (blueprint §6.1): hubs, vehicles, route templates, and who rides
 * which route.
 *
 * The Features tab is where the two blueprint-excluded features live. They are
 * built and switched off — see supabase/schema.sql `organization`.
 */
export default function StaffSetup() {
  const { isAdmin } = useAuth();
  const { org, reload: reloadOrg } = useOrg();
  const ref = useReference();

  const [tab, setTab] = useState<Tab>('routes');
  const [error, setError] = useState('');

  const [students, setStudents] = useState<Profile[]>([]);
  const [assignments, setAssignments] = useState<RouteAssignment[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);

  const [hubName, setHubName] = useState('');
  const [hubLat, setHubLat] = useState('');
  const [hubLng, setHubLng] = useState('');

  const [vanLabel, setVanLabel] = useState('');
  const [vanPlate, setVanPlate] = useState('');
  const [vanCap, setVanCap] = useState('16');

  const [deviceKeys, setDeviceKeys] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const [{ data: st }, { data: ra }, { data: keys }] = await Promise.all([
      supabase.from('profiles').select('*').eq('role', 'student').eq('status', 'active').order('full_name'),
      supabase.from('route_assignments').select('*'),
      supabase.from('vehicle_devices').select('vehicle_id, device_key'),
    ]);
    setStudents((st as Profile[]) ?? []);
    setAssignments((ra as RouteAssignment[]) ?? []);
    setDeviceKeys(
      Object.fromEntries(
        ((keys as { vehicle_id: string; device_key: string }[]) ?? []).map((k) => [
          k.vehicle_id,
          k.device_key,
        ]),
      ),
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleAssignment(routeId: string, studentId: string, stops: RouteStop[]) {
    setError('');
    const existing = assignments.find(
      (a) => a.route_id === routeId && a.student_id === studentId,
    );

    if (existing) {
      await supabase.from('route_assignments').delete().eq('id', existing.id);
    } else {
      // Seat them at the hub the office already recorded for them, and drop them
      // at the school stop (or the reverse for an afternoon run).
      const route = ref.routeOf(routeId);
      const { data: s } = await supabase
        .from('students')
        .select('*')
        .eq('student_id', studentId)
        .maybeSingle();

      const hubId =
        route?.type === 'afternoon' ? s?.afternoon_hub_id : s?.morning_hub_id;

      const hubStop = stops.find((st) => st.hub_id === hubId);
      const schoolStop = stops.find((st) => st.school_id);

      if (!hubStop) {
        setError(
          'That student has no hub set for this route type. Set their hubs on the People tab first.',
        );
        return;
      }

      const pickup = route?.type === 'afternoon' ? schoolStop : hubStop;
      const dropoff = route?.type === 'afternoon' ? hubStop : schoolStop;

      const { error: e } = await supabase.from('route_assignments').insert({
        route_id: routeId,
        student_id: studentId,
        pickup_stop_id: pickup?.id ?? null,
        dropoff_stop_id: dropoff?.id ?? null,
      });
      if (e) {
        setError(e.message);
        return;
      }
    }

    await load();
  }

  async function addHub() {
    setError('');
    const lat = Number(hubLat);
    const lng = Number(hubLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setError('Latitude and longitude must be numbers, e.g. 37.3349 and -122.0090.');
      return;
    }
    const { error: e } = await supabase
      .from('hubs')
      .insert({ name: hubName.trim(), lat, lng });
    if (e) {
      setError(e.message);
      return;
    }
    setHubName('');
    setHubLat('');
    setHubLng('');
    await ref.reload();
  }

  async function addVehicle() {
    setError('');
    const { error: e } = await supabase.from('vehicles').insert({
      label: vanLabel.trim(),
      plate: vanPlate.trim() || null,
      capacity: Number(vanCap) || 16,
    });
    if (e) {
      setError(e.message);
      return;
    }
    setVanLabel('');
    setVanPlate('');
    await ref.reload();
    await load();
  }

  async function setFlag(patch: { gps_enabled?: boolean; payments_enabled?: boolean }) {
    setError('');
    const { error: e } = await supabase.from('organization').update(patch).eq('id', 1);
    if (e) {
      setError(
        e.code === '42501' ? 'Only an administrator can change these.' : e.message,
      );
      return;
    }
    await reloadOrg();
  }

  if (ref.loading) return <Loading />;

  const TABS: { value: Tab; label: string }[] = [
    { value: 'routes', label: 'Routes' },
    { value: 'hubs', label: 'Hubs' },
    { value: 'fleet', label: 'Fleet' },
    { value: 'features', label: 'Features' },
  ];

  return (
    <Screen>
      <Title sub="Hubs, vans, routes, and who rides them.">Setup</Title>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {TABS.map((t) => (
          <Pressable
            key={t.value}
            onPress={() => setTab(t.value)}
            style={[styles.chip, tab === t.value && styles.chipActive]}
          >
            <Text style={[styles.chipText, tab === t.value && styles.chipTextActive]}>
              {t.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <ErrorText>{error}</ErrorText>

      {tab === 'routes' ? (
        <>
          {ref.routes.length === 0 ? <Empty>No route templates yet.</Empty> : null}

          {ref.routes.map((route) => {
            const stops = ref.stopsFor(route.id);
            const riders = assignments.filter((a) => a.route_id === route.id);
            const open = selectedRoute === route.id;

            return (
              <Card key={route.id}>
                <Row style={styles.between}>
                  <View style={styles.grow}>
                    <Text style={styles.name}>{route.name}</Text>
                    <Text style={styles.fine}>
                      {ROUTE_TYPE_LABEL[route.type]} · {stops.length} stops · {riders.length}{' '}
                      students
                    </Text>
                    <Text style={styles.fine}>
                      Runs {route.operating_weekdays.map((d) => WEEKDAYS[d - 1]).join(', ')}
                    </Text>
                  </View>
                  <Badge label={route.active ? 'Active' : 'Off'} tone={route.active ? 'success' : 'neutral'} />
                </Row>

                <View style={styles.stops}>
                  {stops.map((s) => (
                    <Text key={s.id} style={styles.stop}>
                      {s.seq}. {ref.stopName(s.id)}
                      {s.planned_arrival ? ` · ${s.planned_arrival.slice(0, 5)}` : ''}
                      {s.planned_departure ? ` → ${s.planned_departure.slice(0, 5)}` : ''}
                    </Text>
                  ))}
                </View>

                <Button
                  label={open ? 'Hide students' : 'Assign students'}
                  variant="secondary"
                  onPress={() => setSelectedRoute(open ? null : route.id)}
                />

                {open ? (
                  students.length === 0 ? (
                    <Text style={styles.fine}>
                      No approved students yet. Approve them on the People tab first.
                    </Text>
                  ) : (
                    <View style={styles.assign}>
                      {students.map((s) => {
                        const on = riders.some((r) => r.student_id === s.id);
                        return (
                          <Button
                            key={s.id}
                            label={`${on ? '✓ ' : ''}${s.full_name}`}
                            variant={on ? 'primary' : 'secondary'}
                            onPress={() => toggleAssignment(route.id, s.id, stops)}
                          />
                        );
                      })}
                      <Text style={styles.fine}>
                        A student is seated at the hub recorded on their profile. If they have no
                        hub set, set it on the People tab first.
                      </Text>
                    </View>
                  )
                ) : null}
              </Card>
            );
          })}
        </>
      ) : null}

      {tab === 'hubs' ? (
        <>
          {ref.hubs.map((h) => (
            <Card key={h.id}>
              <Row style={styles.between}>
                <View style={styles.grow}>
                  <Text style={styles.name}>{h.name}</Text>
                  <Text style={styles.fine}>
                    {h.lat.toFixed(4)}, {h.lng.toFixed(4)}
                    {h.address ? ` · ${h.address}` : ''}
                  </Text>
                </View>
                <Button
                  label="Delete"
                  variant="danger"
                  onPress={() =>
                    Alert.alert('Delete hub?', `${h.name} will be removed from every route.`, [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: async () => {
                          await supabase.from('hubs').delete().eq('id', h.id);
                          await ref.reload();
                        },
                      },
                    ])
                  }
                />
              </Row>
            </Card>
          ))}

          <SectionLabel>Add a hub</SectionLabel>
          <Card>
            <Field label="Name" value={hubName} onChangeText={setHubName} placeholder="Rancho Clubhouse" />
            <Row>
              <View style={styles.grow}>
                <Field
                  label="Latitude"
                  value={hubLat}
                  onChangeText={setHubLat}
                  keyboardType="numbers-and-punctuation"
                  placeholder="37.3230"
                />
              </View>
              <View style={styles.grow}>
                <Field
                  label="Longitude"
                  value={hubLng}
                  onChangeText={setHubLng}
                  keyboardType="numbers-and-punctuation"
                  placeholder="-122.0140"
                />
              </View>
            </Row>
            <Text style={styles.fine}>
              Long-press a spot in any maps app and copy the coordinate pair it shows.
            </Text>
            <Button label="Add hub" onPress={addHub} disabled={!hubName.trim() || !hubLat || !hubLng} />
          </Card>
        </>
      ) : null}

      {tab === 'fleet' ? (
        <>
          {ref.vehicles.map((v) => (
            <Card key={v.id}>
              <Row style={styles.between}>
                <View style={styles.grow}>
                  <Text style={styles.name}>
                    {v.label}
                    {v.plate ? ` · ${v.plate}` : ''}
                  </Text>
                  <Text style={styles.fine}>Seats {v.capacity}</Text>
                </View>
                <Badge label={v.active ? 'Active' : 'Off'} tone={v.active ? 'success' : 'neutral'} />
              </Row>
              {isAdmin && deviceKeys[v.id] ? (
                <Text style={styles.fine} selectable>
                  GPS device key: {deviceKeys[v.id]} (unused while tracking is off)
                </Text>
              ) : null}
            </Card>
          ))}

          <SectionLabel>Add a van</SectionLabel>
          <Card>
            <Field label="Name" value={vanLabel} onChangeText={setVanLabel} placeholder="Van 4" />
            <Row>
              <View style={styles.grow}>
                <Field label="Plate" value={vanPlate} onChangeText={setVanPlate} placeholder="9ABC123" />
              </View>
              <View style={styles.grow}>
                <Field
                  label="Seats"
                  value={vanCap}
                  onChangeText={setVanCap}
                  keyboardType="number-pad"
                  placeholder="16"
                />
              </View>
            </Row>
            <Button label="Add van" onPress={addVehicle} disabled={!vanLabel.trim()} />
          </Card>
        </>
      ) : null}

      {tab === 'features' ? (
        <>
          <Card>
            <Text style={styles.body}>
              Two features are fully built but switched off, because the MVP blueprint excludes them
              from the first release. Nothing was cut — these flip them on.
            </Text>
          </Card>

          <Card>
            <Row style={styles.between}>
              <View style={styles.grow}>
                <Text style={styles.name}>Live GPS tracking</Text>
                <Text style={styles.fine}>
                  Driver phone streaming plus an HTTP endpoint for hardware trackers.
                </Text>
              </View>
              <Switch
                value={org?.gps_enabled ?? false}
                disabled={!isAdmin}
                onValueChange={(v) => setFlag({ gps_enabled: v })}
              />
            </Row>
            <View style={styles.quote}>
              <Text style={styles.quoteText}>
                “Do not continuously write vehicle GPS coordinates in the first release. Add GPS only
                after measuring cost and battery impact.”
              </Text>
              <Text style={styles.cite}>Blueprint §8 — Cost-control requirements</Text>
            </View>
          </Card>

          <Card>
            <Row style={styles.between}>
              <View style={styles.grow}>
                <Text style={styles.name}>Payments</Text>
                <Text style={styles.fine}>
                  Invoices, history, balances, and reminders. No card processing.
                </Text>
              </View>
              <Switch
                value={org?.payments_enabled ?? false}
                disabled={!isAdmin}
                onValueChange={(v) => setFlag({ payments_enabled: v })}
              />
            </Row>
            <View style={styles.quote}>
              <Text style={styles.quoteText}>“Payments, subscriptions, invoicing, or payroll.”</Text>
              <Text style={styles.cite}>Blueprint §1.2 — Explicitly excluded</Text>
            </View>
          </Card>

          {!isAdmin ? (
            <Card>
              <Text style={styles.fine}>
                Only an administrator can change these. The database refuses it for coordinators.
              </Text>
            </Card>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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
  between: { justifyContent: 'space-between' },
  grow: { flex: 1 },
  name: { fontSize: 15, fontWeight: '700', color: theme.text },
  body: { fontSize: 14, color: theme.muted, lineHeight: 20 },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  stops: { gap: 3, paddingLeft: 4 },
  stop: { fontSize: 13, color: theme.muted },
  assign: { gap: 8, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 12 },
  quote: { borderLeftWidth: 2, borderLeftColor: theme.accent, paddingLeft: 12, gap: 3 },
  quoteText: { fontSize: 12, color: theme.text, lineHeight: 18, fontStyle: 'italic' },
  cite: { fontSize: 11, color: theme.faint, fontWeight: '600' },
});
