import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useAuth } from '../../src/lib/auth';
import { useOrg } from '../../src/lib/org';
import { supabase } from '../../src/lib/supabase';
import { useReference } from '../../src/lib/hooks';
import { ROUTE_TYPE_LABEL } from '../../src/lib/types';
import type {
  Hub,
  Profile,
  RouteAssignment,
  RouteStop,
  RouteTemplate,
  RouteType,
  Vehicle,
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

type Tab = 'routes' | 'hubs' | 'fleet' | 'features';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ROUTE_TYPES: RouteType[] = ['morning', 'afternoon', 'club', 'emergency'];

/**
 * Configuration (blueprint §6.1): "Create schools, hubs, vehicles, and route
 * templates."
 *
 * Everything an administrator needs to run the system without touching SQL:
 * routes and the ordered stops on them, the permanent driver and van for each
 * route, who rides it, the hubs themselves, and the fleet.
 *
 * Note the difference between the two ways to change a driver:
 *   - HERE sets the route's *default* driver — every future day picks it up.
 *   - The Dashboard's trip board swaps the driver for ONE day only, which is the
 *     blueprint's substitution flow (§6.3, "Driver absent").
 * Changing the default does not touch a day that has already been generated.
 */
export default function StaffSetup() {
  const { profile, isAdmin } = useAuth();
  const { org, reload: reloadOrg } = useOrg();
  const ref = useReference();

  const [tab, setTab] = useState<Tab>('routes');
  const [error, setError] = useState('');

  const [students, setStudents] = useState<Profile[]>([]);
  const [drivers, setDrivers] = useState<Profile[]>([]);
  const [assignments, setAssignments] = useState<RouteAssignment[]>([]);
  const [deviceKeys, setDeviceKeys] = useState<Record<string, string>>({});

  /** Which route is expanded, and which panel inside it. */
  const [openRoute, setOpenRoute] = useState<string | null>(null);
  const [panel, setPanel] = useState<'stops' | 'crew' | 'riders' | null>(null);

  // New route
  const [newRouteName, setNewRouteName] = useState('');
  const [newRouteType, setNewRouteType] = useState<RouteType>('morning');
  const [creatingRoute, setCreatingRoute] = useState(false);

  // Stop being added / edited
  const [editingStop, setEditingStop] = useState<RouteStop | null>(null);
  const [stopArrive, setStopArrive] = useState('');
  const [stopDepart, setStopDepart] = useState('');

  // Hub form (doubles as the editor)
  const [editingHub, setEditingHub] = useState<Hub | null>(null);
  const [hubName, setHubName] = useState('');
  const [hubLat, setHubLat] = useState('');
  const [hubLng, setHubLng] = useState('');

  // Vehicle form (doubles as the editor)
  const [editingVan, setEditingVan] = useState<Vehicle | null>(null);
  const [vanLabel, setVanLabel] = useState('');
  const [vanPlate, setVanPlate] = useState('');
  const [vanCap, setVanCap] = useState('16');

  const load = useCallback(async () => {
    const [{ data: st }, { data: dr }, { data: ra }, { data: keys }] = await Promise.all([
      supabase.from('profiles').select('*').eq('role', 'student').eq('status', 'active').order('full_name'),
      supabase.from('profiles').select('*').eq('role', 'driver').eq('status', 'active').order('full_name'),
      supabase.from('route_assignments').select('*'),
      supabase.from('vehicle_devices').select('vehicle_id, device_key'),
    ]);
    setStudents((st as Profile[]) ?? []);
    setDrivers((dr as Profile[]) ?? []);
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

  // Same reason as the People tab: tabs stay mounted, so loading once on mount
  // meant a driver or student who joined while the portal was open never showed
  // up in these pickers.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const refreshAll = useCallback(async () => {
    await Promise.all([ref.reload(), load()]);
  }, [ref, load]);

  // -- routes ---------------------------------------------------------------

  async function createRoute() {
    setError('');
    setCreatingRoute(true);
    const { error: e } = await supabase.from('route_templates').insert({
      name: newRouteName.trim(),
      type: newRouteType,
      school_id: ref.schools[0]?.id ?? null,
    });
    setCreatingRoute(false);
    if (e) return setError(staffError(e));
    setNewRouteName('');
    await refreshAll();
  }

  async function patchRoute(routeId: string, patch: Partial<RouteTemplate>) {
    setError('');
    const { error: e } = await supabase.from('route_templates').update(patch).eq('id', routeId);
    if (e) return setError(staffError(e));
    await refreshAll();
  }

  function deleteRoute(route: RouteTemplate) {
    Alert.alert(
      `Delete ${route.name}?`,
      'Its stops, student assignments, and past trips go with it. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const { error: e } = await supabase.from('route_templates').delete().eq('id', route.id);
            if (e) return setError(staffError(e));
            setOpenRoute(null);
            await refreshAll();
          },
        },
      ],
    );
  }

  /** Toggle a weekday on the route's operating schedule. */
  async function toggleWeekday(route: RouteTemplate, isoDay: number) {
    const next = route.operating_weekdays.includes(isoDay)
      ? route.operating_weekdays.filter((d) => d !== isoDay)
      : [...route.operating_weekdays, isoDay].sort();
    await patchRoute(route.id, { operating_weekdays: next });
  }

  // -- stops ----------------------------------------------------------------

  /** Append a hub (or the school) to the end of a route. */
  async function addStop(route: RouteTemplate, hubId: string | null, schoolId: string | null) {
    setError('');
    const stops = ref.stopsFor(route.id);
    const nextSeq = stops.length ? Math.max(...stops.map((s) => s.seq)) + 1 : 1;

    const { error: e } = await supabase.from('route_stops').insert({
      route_id: route.id,
      seq: nextSeq,
      hub_id: hubId,
      school_id: schoolId,
    });
    if (e) return setError(staffError(e));
    await refreshAll();
  }

  /** Reordering swaps the two stops' seq values — no gaps, no renumbering. */
  async function moveStop(route: RouteTemplate, stop: RouteStop, direction: -1 | 1) {
    const stops = ref.stopsFor(route.id);
    const index = stops.findIndex((s) => s.id === stop.id);
    const other = stops[index + direction];
    if (!other) return;

    setError('');
    const [a, b] = await Promise.all([
      supabase.from('route_stops').update({ seq: other.seq }).eq('id', stop.id),
      supabase.from('route_stops').update({ seq: stop.seq }).eq('id', other.id),
    ]);
    if (a.error || b.error) return setError(staffError(a.error ?? b.error!));
    await refreshAll();
  }

  async function saveStopTimes() {
    if (!editingStop) return;
    setError('');

    // Postgres `time` accepts HH:MM. Empty means "no planned time".
    const clean = (v: string) => (/^\d{1,2}:\d{2}$/.test(v.trim()) ? v.trim() : null);
    if (stopArrive.trim() && !clean(stopArrive)) return setError('Arrival must look like 07:05.');
    if (stopDepart.trim() && !clean(stopDepart)) return setError('Departure must look like 07:10.');

    const { error: e } = await supabase
      .from('route_stops')
      .update({ planned_arrival: clean(stopArrive), planned_departure: clean(stopDepart) })
      .eq('id', editingStop.id);

    if (e) return setError(staffError(e));
    setEditingStop(null);
    await refreshAll();
  }

  function deleteStop(stop: RouteStop) {
    const riders = assignments.filter(
      (a) => a.pickup_stop_id === stop.id || a.dropoff_stop_id === stop.id,
    ).length;

    Alert.alert(
      `Remove ${ref.stopName(stop.id)}?`,
      riders > 0
        ? `${riders} student${riders === 1 ? ' is' : 's are'} assigned to this stop. They will be left without one and you will have to re-assign them to the route.`
        : 'This stop will be removed from the route.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            const { error: e } = await supabase.from('route_stops').delete().eq('id', stop.id);
            if (e) return setError(staffError(e));
            await refreshAll();
          },
        },
      ],
    );
  }

  // -- riders ---------------------------------------------------------------

  async function toggleRider(route: RouteTemplate, studentId: string) {
    setError('');
    const existing = assignments.find(
      (a) => a.route_id === route.id && a.student_id === studentId,
    );

    if (existing) {
      await supabase.from('route_assignments').delete().eq('id', existing.id);
      await load();
      return;
    }

    const stops = ref.stopsFor(route.id);
    const { data: s } = await supabase
      .from('students')
      .select('*')
      .eq('student_id', studentId)
      .maybeSingle();

    const hubId = route.type === 'afternoon' ? s?.afternoon_hub_id : s?.morning_hub_id;
    const hubStop = stops.find((st) => st.hub_id === hubId);
    const schoolStop = stops.find((st) => st.school_id);

    if (!hubStop) {
      return setError(
        'That student has no hub set for this route type, or the route has no stop at their hub. Set their hubs on the People tab, and make sure that hub is a stop on this route.',
      );
    }

    // Morning runs hub -> school; afternoon runs school -> hub.
    const pickup = route.type === 'afternoon' ? schoolStop : hubStop;
    const dropoff = route.type === 'afternoon' ? hubStop : schoolStop;

    const { error: e } = await supabase.from('route_assignments').insert({
      route_id: route.id,
      student_id: studentId,
      pickup_stop_id: pickup?.id ?? null,
      dropoff_stop_id: dropoff?.id ?? null,
    });
    if (e) return setError(staffError(e));
    await load();
  }

  // -- hubs -----------------------------------------------------------------

  async function saveHub() {
    setError('');
    const lat = Number(hubLat);
    const lng = Number(hubLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return setError('Latitude and longitude must be numbers, e.g. 37.3349 and -122.0090.');
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return setError('Latitude is -90 to 90; longitude is -180 to 180. They may be the wrong way round.');
    }

    const payload = { name: hubName.trim(), lat, lng };
    const { error: e } = editingHub
      ? await supabase.from('hubs').update(payload).eq('id', editingHub.id)
      : await supabase.from('hubs').insert(payload);

    if (e) return setError(staffError(e));
    clearHubForm();
    await refreshAll();
  }

  function clearHubForm() {
    setEditingHub(null);
    setHubName('');
    setHubLat('');
    setHubLng('');
  }

  function deleteHub(hub: Hub) {
    // A hub used by a route takes its stops with it (ON DELETE CASCADE), so say so.
    const usedBy = ref.stops.filter((s) => s.hub_id === hub.id).length;
    Alert.alert(
      `Delete ${hub.name}?`,
      usedBy > 0
        ? `It is a stop on ${usedBy} route${usedBy === 1 ? '' : 's'}. Deleting it removes those stops too, and any student assigned there loses their stop.`
        : 'This hub is not used by any route.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const { error: e } = await supabase.from('hubs').delete().eq('id', hub.id);
            if (e) return setError(staffError(e));
            await refreshAll();
          },
        },
      ],
    );
  }

  // -- fleet ----------------------------------------------------------------

  async function saveVan() {
    setError('');
    const capacity = Number(vanCap);
    if (!Number.isInteger(capacity) || capacity < 1) {
      return setError('Seats must be a whole number.');
    }

    const payload = { label: vanLabel.trim(), plate: vanPlate.trim() || null, capacity };
    const { error: e } = editingVan
      ? await supabase.from('vehicles').update(payload).eq('id', editingVan.id)
      : await supabase.from('vehicles').insert(payload);

    if (e) return setError(staffError(e));
    clearVanForm();
    await refreshAll();
  }

  function clearVanForm() {
    setEditingVan(null);
    setVanLabel('');
    setVanPlate('');
    setVanCap('16');
  }

  async function setFlag(patch: { gps_enabled?: boolean; payments_enabled?: boolean }) {
    setError('');
    const { error: e } = await supabase.from('organization').update(patch).eq('id', 1);
    if (e) return setError(staffError(e));
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
      <Title sub="Routes, stops, crews, hubs, and vans.">Setup</Title>

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

      {/* ------------------------------------------------------------ ROUTES */}
      {tab === 'routes' ? (
        <>
          {ref.routes.length === 0 ? <Empty>No routes yet. Create one below.</Empty> : null}

          {ref.routes.map((route) => {
            const stops = ref.stopsFor(route.id);
            const riders = assignments.filter((a) => a.route_id === route.id);
            const open = openRoute === route.id;
            const driver = drivers.find((d) => d.id === route.default_driver_id);
            const van = ref.vehicleOf(route.default_vehicle_id);
            const overCapacity = van ? riders.length > van.capacity : false;

            return (
              <Card key={route.id}>
                <Pressable
                  onPress={() => {
                    setOpenRoute(open ? null : route.id);
                    setPanel(open ? null : 'stops');
                    setEditingStop(null);
                  }}
                >
                  <Row style={styles.between}>
                    <View style={styles.grow}>
                      <Text style={styles.name}>{route.name}</Text>
                      <Text style={styles.fine}>
                        {ROUTE_TYPE_LABEL[route.type]} · {stops.length} stops · {riders.length}{' '}
                        students
                      </Text>
                      <Text style={styles.fine}>
                        {driver?.full_name ?? 'NO DRIVER'} · {van?.label ?? 'no van'} ·{' '}
                        {route.operating_weekdays.map((d) => WEEKDAYS[d - 1]).join(' ')}
                      </Text>
                    </View>
                    <Text style={styles.chev}>{open ? '⌄' : '›'}</Text>
                  </Row>
                </Pressable>

                {!route.default_driver_id ? (
                  <Text style={styles.warn}>⚠ No driver — this route cannot run.</Text>
                ) : null}
                {overCapacity ? (
                  <Text style={styles.warn}>
                    ⚠ {riders.length} students but {van?.label} seats {van?.capacity}.
                  </Text>
                ) : null}

                {open ? (
                  <>
                    <Row style={styles.wrap}>
                      {(['stops', 'crew', 'riders'] as const).map((p) => (
                        <Button
                          key={p}
                          label={p === 'crew' ? 'Driver & van' : p === 'stops' ? 'Stops' : 'Students'}
                          variant={panel === p ? 'primary' : 'secondary'}
                          onPress={() => setPanel(p)}
                          style={styles.grow}
                        />
                      ))}
                    </Row>

                    {/* ---- stops ---- */}
                    {panel === 'stops' ? (
                      <View style={styles.panel}>
                        {stops.length === 0 ? (
                          <Text style={styles.fine}>
                            No stops yet. Add the hubs this route serves, in the order the van
                            visits them, and finish at the school (or start there, for an afternoon
                            run).
                          </Text>
                        ) : null}

                        {stops.map((stop, i) => {
                          const isSchool = Boolean(stop.school_id);
                          const editing = editingStop?.id === stop.id;

                          return (
                            <View key={stop.id} style={styles.stopRow}>
                              <Row style={styles.between}>
                                <View style={styles.grow}>
                                  <Text style={styles.stopName}>
                                    {stop.seq}. {ref.stopName(stop.id)}
                                    {isSchool ? ' 🏫' : ''}
                                  </Text>
                                  <Text style={styles.fine}>
                                    {stop.planned_arrival
                                      ? `arrive ${stop.planned_arrival.slice(0, 5)}`
                                      : 'no arrival time'}
                                    {stop.planned_departure
                                      ? ` · depart ${stop.planned_departure.slice(0, 5)}`
                                      : ''}
                                  </Text>
                                </View>
                              </Row>

                              {editing ? (
                                <>
                                  <Row>
                                    <View style={styles.grow}>
                                      <Field
                                        label="Arrive"
                                        value={stopArrive}
                                        onChangeText={setStopArrive}
                                        placeholder="07:05"
                                      />
                                    </View>
                                    <View style={styles.grow}>
                                      <Field
                                        label="Depart"
                                        value={stopDepart}
                                        onChangeText={setStopDepart}
                                        placeholder="07:10"
                                      />
                                    </View>
                                  </Row>
                                  <Row>
                                    <Button
                                      label="Save times"
                                      onPress={saveStopTimes}
                                      style={styles.grow}
                                    />
                                    <Button
                                      label="Cancel"
                                      variant="ghost"
                                      onPress={() => setEditingStop(null)}
                                    />
                                  </Row>
                                </>
                              ) : (
                                <Row style={styles.wrap}>
                                  <Button
                                    label="↑"
                                    variant="secondary"
                                    disabled={i === 0}
                                    onPress={() => moveStop(route, stop, -1)}
                                    style={styles.iconBtn}
                                  />
                                  <Button
                                    label="↓"
                                    variant="secondary"
                                    disabled={i === stops.length - 1}
                                    onPress={() => moveStop(route, stop, 1)}
                                    style={styles.iconBtn}
                                  />
                                  <Button
                                    label="Times"
                                    variant="secondary"
                                    style={styles.grow}
                                    onPress={() => {
                                      setEditingStop(stop);
                                      setStopArrive(stop.planned_arrival?.slice(0, 5) ?? '');
                                      setStopDepart(stop.planned_departure?.slice(0, 5) ?? '');
                                    }}
                                  />
                                  <Button
                                    label="Remove"
                                    variant="danger"
                                    onPress={() => deleteStop(stop)}
                                  />
                                </Row>
                              )}
                            </View>
                          );
                        })}

                        <SectionLabel>Add a stop</SectionLabel>
                        <Text style={styles.fine}>Hubs</Text>
                        <Row style={styles.wrap}>
                          {ref.hubs.map((h) => {
                            const already = stops.some((s) => s.hub_id === h.id);
                            return (
                              <Button
                                key={h.id}
                                label={already ? `✓ ${h.name}` : h.name}
                                variant="secondary"
                                disabled={already}
                                onPress={() => addStop(route, h.id, null)}
                              />
                            );
                          })}
                        </Row>
                        <Text style={styles.fine}>Schools</Text>
                        <Row style={styles.wrap}>
                          {ref.schools.map((s) => {
                            const already = stops.some((st) => st.school_id === s.id);
                            return (
                              <Button
                                key={s.id}
                                label={already ? `✓ ${s.name}` : s.name}
                                variant="secondary"
                                disabled={already}
                                onPress={() => addStop(route, null, s.id)}
                              />
                            );
                          })}
                        </Row>
                        <Text style={styles.fine}>
                          Stops are added to the end — use ↑ ↓ to put them in the order the van
                          actually drives.
                        </Text>
                      </View>
                    ) : null}

                    {/* ---- driver & van ---- */}
                    {panel === 'crew' ? (
                      <View style={styles.panel}>
                        <Text style={styles.fine}>
                          The route's permanent driver. Every day generated from now on uses them.
                          To swap a driver for one day only, use the trip board on the Dashboard —
                          that is the substitution flow, and it leaves this unchanged.
                        </Text>
                        <Row style={styles.wrap}>
                          {drivers.length === 0 ? (
                            <Text style={styles.fine}>
                              No drivers yet. Invite one from the People tab.
                            </Text>
                          ) : (
                            drivers.map((d) => (
                              <Button
                                key={d.id}
                                label={d.full_name}
                                variant={route.default_driver_id === d.id ? 'primary' : 'secondary'}
                                onPress={() =>
                                  patchRoute(route.id, {
                                    default_driver_id:
                                      route.default_driver_id === d.id ? null : d.id,
                                  })
                                }
                              />
                            ))
                          )}
                        </Row>

                        <SectionLabel>Van</SectionLabel>
                        <Row style={styles.wrap}>
                          {ref.vehicles.map((v) => (
                            <Button
                              key={v.id}
                              label={`${v.label} (${v.capacity})`}
                              variant={route.default_vehicle_id === v.id ? 'primary' : 'secondary'}
                              onPress={() =>
                                patchRoute(route.id, {
                                  default_vehicle_id:
                                    route.default_vehicle_id === v.id ? null : v.id,
                                })
                              }
                            />
                          ))}
                        </Row>

                        <SectionLabel>Runs on</SectionLabel>
                        <Row style={styles.wrap}>
                          {WEEKDAYS.map((label, i) => {
                            const iso = i + 1;
                            const on = route.operating_weekdays.includes(iso);
                            return (
                              <Button
                                key={label}
                                label={label}
                                variant={on ? 'primary' : 'secondary'}
                                onPress={() => toggleWeekday(route, iso)}
                              />
                            );
                          })}
                        </Row>

                        <SectionLabel>Danger</SectionLabel>
                        <Button
                          label={route.active ? 'Pause this route' : 'Resume this route'}
                          variant="secondary"
                          onPress={() => patchRoute(route.id, { active: !route.active })}
                        />
                        <Button
                          label="Delete route"
                          variant="danger"
                          onPress={() => deleteRoute(route)}
                        />
                      </View>
                    ) : null}

                    {/* ---- students ---- */}
                    {panel === 'riders' ? (
                      <View style={styles.panel}>
                        {students.length === 0 ? (
                          <Text style={styles.fine}>
                            No students yet. Invite one from the People tab.
                          </Text>
                        ) : (
                          <>
                            <Row style={styles.wrap}>
                              {students.map((s) => {
                                const on = riders.some((r) => r.student_id === s.id);
                                return (
                                  <Button
                                    key={s.id}
                                    label={`${on ? '✓ ' : ''}${s.full_name}`}
                                    variant={on ? 'primary' : 'secondary'}
                                    onPress={() => toggleRider(route, s.id)}
                                  />
                                );
                              })}
                            </Row>
                            <Text style={styles.fine}>
                              A student is seated at whichever hub is on their profile, so that hub
                              has to be a stop on this route. Set their hubs on the People tab.
                            </Text>
                          </>
                        )}
                      </View>
                    ) : null}
                  </>
                ) : null}
              </Card>
            );
          })}

          <SectionLabel>New route</SectionLabel>
          <Card>
            <Field
              label="Name"
              value={newRouteName}
              onChangeText={setNewRouteName}
              placeholder="M-02 Morning"
            />
            <Row style={styles.wrap}>
              {ROUTE_TYPES.map((t) => (
                <Button
                  key={t}
                  label={ROUTE_TYPE_LABEL[t]}
                  variant={newRouteType === t ? 'primary' : 'secondary'}
                  onPress={() => setNewRouteType(t)}
                />
              ))}
            </Row>
            <Button
              label="Create route"
              onPress={createRoute}
              loading={creatingRoute}
              disabled={!newRouteName.trim()}
            />
            <Text style={styles.fine}>
              It starts with no stops, no driver, and Mon–Fri. Open it to fill those in.
            </Text>
          </Card>
        </>
      ) : null}

      {/* -------------------------------------------------------------- HUBS */}
      {tab === 'hubs' ? (
        <>
          {ref.hubs.map((h) => {
            const usedBy = ref.stops.filter((s) => s.hub_id === h.id).length;
            return (
              <Card key={h.id}>
                <Row style={styles.between}>
                  <View style={styles.grow}>
                    <Text style={styles.name}>{h.name}</Text>
                    <Text style={styles.fine}>
                      {h.lat.toFixed(4)}, {h.lng.toFixed(4)}
                    </Text>
                    <Text style={styles.fine}>
                      {usedBy === 0 ? 'Not on any route' : `A stop on ${usedBy} route${usedBy === 1 ? '' : 's'}`}
                    </Text>
                  </View>
                  <Badge label={usedBy ? 'In use' : 'Unused'} tone={usedBy ? 'success' : 'neutral'} />
                </Row>
                <Row>
                  <Button
                    label="Edit"
                    variant="secondary"
                    style={styles.grow}
                    onPress={() => {
                      setEditingHub(h);
                      setHubName(h.name);
                      setHubLat(String(h.lat));
                      setHubLng(String(h.lng));
                    }}
                  />
                  <Button label="Delete" variant="danger" onPress={() => deleteHub(h)} />
                </Row>
              </Card>
            );
          })}

          <SectionLabel>{editingHub ? `Edit ${editingHub.name}` : 'Add a hub'}</SectionLabel>
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
              Long-press the spot in any maps app and copy the coordinate pair it shows.
            </Text>
            <Button
              label={editingHub ? 'Save changes' : 'Add hub'}
              onPress={saveHub}
              disabled={!hubName.trim() || !hubLat.trim() || !hubLng.trim()}
            />
            {editingHub ? <Button label="Cancel" variant="ghost" onPress={clearHubForm} /> : null}
          </Card>
        </>
      ) : null}

      {/* ------------------------------------------------------------- FLEET */}
      {tab === 'fleet' ? (
        <>
          {ref.vehicles.map((v) => {
            const usedBy = ref.routes.filter((r) => r.default_vehicle_id === v.id).length;
            return (
              <Card key={v.id}>
                <Row style={styles.between}>
                  <View style={styles.grow}>
                    <Text style={styles.name}>
                      {v.label}
                      {v.plate ? ` · ${v.plate}` : ''}
                    </Text>
                    <Text style={styles.fine}>
                      Seats {v.capacity}
                      {usedBy ? ` · on ${usedBy} route${usedBy === 1 ? '' : 's'}` : ' · unassigned'}
                    </Text>
                  </View>
                  <Badge label={v.active ? 'Active' : 'Retired'} tone={v.active ? 'success' : 'neutral'} />
                </Row>

                {isAdmin && deviceKeys[v.id] ? (
                  <Text style={styles.fine} selectable>
                    GPS key: {deviceKeys[v.id]} (unused while tracking is off)
                  </Text>
                ) : null}

                <Row>
                  <Button
                    label="Edit"
                    variant="secondary"
                    style={styles.grow}
                    onPress={() => {
                      setEditingVan(v);
                      setVanLabel(v.label);
                      setVanPlate(v.plate ?? '');
                      setVanCap(String(v.capacity));
                    }}
                  />
                  <Button
                    label={v.active ? 'Retire' : 'Un-retire'}
                    variant="secondary"
                    onPress={async () => {
                      const { error: e } = await supabase
                        .from('vehicles')
                        .update({ active: !v.active })
                        .eq('id', v.id);
                      if (e) return setError(staffError(e));
                      await refreshAll();
                    }}
                  />
                </Row>
              </Card>
            );
          })}

          <SectionLabel>{editingVan ? `Edit ${editingVan.label}` : 'Add a van'}</SectionLabel>
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
            <Button
              label={editingVan ? 'Save changes' : 'Add van'}
              onPress={saveVan}
              disabled={!vanLabel.trim()}
            />
            {editingVan ? <Button label="Cancel" variant="ghost" onPress={clearVanForm} /> : null}
            <Text style={styles.fine}>
              Retiring a van keeps its history but takes it out of the pickers. Deleting is not
              offered, because past trips point at it.
            </Text>
          </Card>
        </>
      ) : null}

      {/* ---------------------------------------------------------- FEATURES */}
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
                Only an administrator can change these. You are signed in as {profile?.role}, and
                the database refuses it.
              </Text>
            </Card>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

/**
 * RLS refusals surface as 42501. Routes, stops, hubs and vans are writable by
 * any staff member; the feature flags are admin-only. So a 42501 here almost
 * always means a coordinator touched the Features switches.
 */
function staffError(e: { code?: string; message: string }) {
  if (e.code === '42501') {
    return 'The database refused that — it is reserved for administrators.';
  }
  return e.message;
}

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
  wrap: { flexWrap: 'wrap' },
  iconBtn: { paddingHorizontal: 18 },
  chev: { fontSize: 20, color: theme.faint },
  name: { fontSize: 15, fontWeight: '700', color: theme.text },
  body: { fontSize: 14, color: theme.muted, lineHeight: 20 },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  warn: { fontSize: 12, color: theme.warn, lineHeight: 17 },
  panel: { gap: 10, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 12 },
  stopRow: {
    gap: 8,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceAlt,
  },
  stopName: { fontSize: 14, fontWeight: '700', color: theme.text },
  quote: { borderLeftWidth: 2, borderLeftColor: theme.accent, paddingLeft: 12, gap: 3 },
  quoteText: { fontSize: 12, color: theme.text, lineHeight: 18, fontStyle: 'italic' },
  cite: { fontSize: 11, color: theme.faint, fontWeight: '600' },
});
