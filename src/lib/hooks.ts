import { useCallback, useEffect, useId, useState } from 'react';
import { supabase } from './supabase';
import type {
  AppNotification,
  DailyTrip,
  Hub,
  Profile,
  RouteStop,
  RouteTemplate,
  School,
  StudentTripStatus,
  Vehicle,
} from './types';

export const today = () => new Date().toISOString().slice(0, 10);

/**
 * The reference data every screen needs to turn ids into names: hubs, schools,
 * vehicles, routes and their stops. Small and rarely changing, so it is loaded
 * once and looked up in memory rather than joined on every query.
 */
export function useReference() {
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [schools, setSchools] = useState<School[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [routes, setRoutes] = useState<RouteTemplate[]>([]);
  const [stops, setStops] = useState<RouteStop[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const [h, s, v, r, st] = await Promise.all([
      supabase.from('hubs').select('*').order('name'),
      supabase.from('schools').select('*').order('name'),
      supabase.from('vehicles').select('*').order('label'),
      supabase.from('route_templates').select('*').order('name'),
      supabase.from('route_stops').select('*').order('seq'),
    ]);
    setHubs((h.data as Hub[]) ?? []);
    setSchools((s.data as School[]) ?? []);
    setVehicles((v.data as Vehicle[]) ?? []);
    setRoutes((r.data as RouteTemplate[]) ?? []);
    setStops((st.data as RouteStop[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  /** Human name for a route stop, which is either a hub or the school. */
  const stopName = useCallback(
    (stopId: string | null | undefined) => {
      if (!stopId) return null;
      const stop = stops.find((s) => s.id === stopId);
      if (!stop) return null;
      if (stop.hub_id) return hubs.find((h) => h.id === stop.hub_id)?.name ?? 'Hub';
      return schools.find((s) => s.id === stop.school_id)?.name ?? 'School';
    },
    [stops, hubs, schools],
  );

  /**
   * The "where exactly?" line for a stop — "Corner of Oak Road and Example Way".
   * Null when the office has not filled it in, so screens can say so rather than
   * printing an empty line.
   */
  const stopAddress = useCallback(
    (stopId: string | null | undefined) => {
      const stop = stops.find((s) => s.id === stopId);
      if (!stop) return null;
      if (stop.hub_id) return hubs.find((h) => h.id === stop.hub_id)?.address ?? null;
      return schools.find((s) => s.id === stop.school_id)?.address ?? null;
    },
    [stops, hubs, schools],
  );

  const stopCoords = useCallback(
    (stopId: string | null | undefined) => {
      const stop = stops.find((s) => s.id === stopId);
      if (!stop) return null;
      if (stop.hub_id) {
        const hub = hubs.find((h) => h.id === stop.hub_id);
        return hub ? { lat: hub.lat, lng: hub.lng } : null;
      }
      const school = schools.find((s) => s.id === stop.school_id);
      return school?.lat != null && school?.lng != null
        ? { lat: school.lat, lng: school.lng }
        : null;
    },
    [stops, hubs, schools],
  );

  return {
    hubs,
    schools,
    vehicles,
    routes,
    stops,
    loading,
    reload,
    stopName,
    stopAddress,
    stopCoords,
    stopsFor: (routeId: string | null | undefined) =>
      stops.filter((s) => s.route_id === routeId).sort((a, b) => a.seq - b.seq),
    // The student's own stop -- the HUB, the one a parent cares about. A student
    // rides between their hub and the school; which of pickup/drop-off is the
    // hub flips with the route direction (morning boards at the hub, afternoon
    // gets off at it). A route_stop is a hub XOR the school, so the hub is
    // whichever of the two is not the school.
    hubStopId: (pickupStopId: string | null, dropoffStopId: string | null) => {
      const pickup = stops.find((s) => s.id === pickupStopId);
      return pickup?.hub_id ? pickupStopId : dropoffStopId;
    },
    routeOf: (routeId: string | null | undefined) => routes.find((r) => r.id === routeId) ?? null,
    vehicleOf: (id: string | null | undefined) => vehicles.find((v) => v.id === id) ?? null,
    hubOf: (id: string | null | undefined) => hubs.find((h) => h.id === id) ?? null,
    schoolOf: (id: string | null | undefined) => schools.find((s) => s.id === id) ?? null,
  };
}

/**
 * A student's trip rows for a date, live.
 *
 * RLS decides whose rows come back: a student sees their own, a parent sees
 * their linked children's, a driver sees the riders on their trips, staff see
 * everything. So the same query serves every screen.
 */
export function useTripStatuses(date: string = today()) {
  const [rows, setRows] = useState<StudentTripStatus[]>([]);
  const [trips, setTrips] = useState<DailyTrip[]>([]);
  const [drivers, setDrivers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);

  // Supabase returns the SAME channel object for a given topic name. Two screens
  // using this hook at once — and tabs stay mounted, so the Dashboard and
  // Exceptions both do — would land on one channel, and the second would try to
  // attach listeners to an already-subscribed channel:
  //   "cannot add `postgres_changes` callbacks ... after `subscribe()`"
  // A per-instance id keeps each subscriber on its own channel.
  const instance = useId();

  const reload = useCallback(async () => {
    const { data: t } = await supabase.from('daily_trips').select('*').eq('date', date);
    const dayTrips = (t as DailyTrip[]) ?? [];
    setTrips(dayTrips);

    if (!dayTrips.length) {
      setRows([]);
      setDrivers([]);
      setLoading(false);
      return;
    }

    const { data: s } = await supabase
      .from('student_trip_status')
      .select('*')
      .in('trip_id', dayTrips.map((x) => x.id));

    setRows((s as StudentTripStatus[]) ?? []);

    // RLS lets a rider (and their guardian) read the profile of the driver on a
    // trip they are actually on today, and nobody else's.
    const driverIds = [...new Set(dayTrips.map((x) => x.driver_id).filter(Boolean))] as string[];
    if (driverIds.length) {
      const { data: d } = await supabase
        .from('profiles')
        .select('*')
        .in('id', driverIds);
      setDrivers((d as Profile[]) ?? []);
    } else {
      setDrivers([]);
    }

    setLoading(false);
  }, [date]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Statuses change from three different devices (student checks in, driver
  // confirms, coordinator overrides), so every screen follows the table rather
  // than polling.
  useEffect(() => {
    const channel = supabase
      .channel(`trip-status:${date}:${instance}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'student_trip_status' }, () =>
        reload(),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'daily_trips' }, () => reload())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [date, instance, reload]);

  return {
    rows,
    trips,
    drivers,
    loading,
    reload,
    driverOf: (id: string | null | undefined) => drivers.find((d) => d.id === id) ?? null,
  };
}

export function useNotifications(userId: string | null | undefined) {
  const [items, setItems] = useState<AppNotification[]>([]);
  // Same reason as useTripStatuses: two mounted screens sharing one topic name
  // would collide on a single channel.
  const instance = useId();

  const reload = useCallback(async () => {
    if (!userId) return;
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    setItems((data as AppNotification[]) ?? []);
  }, [userId]);

  useEffect(() => {
    reload();
    if (!userId) return;

    const channel = supabase
      .channel(`notifications:${userId}:${instance}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => setItems((prev) => [payload.new as AppNotification, ...prev]),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, instance, reload]);

  const markAllRead = useCallback(async () => {
    if (!userId) return;
    await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('read_at', null);
    await reload();
  }, [userId, reload]);

  return { items, unread: items.filter((n) => !n.read_at).length, markAllRead, reload };
}

/** People this parent is linked to (accepted links only). */
export function useMyChildren() {
  const [children, setChildren] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const { data: links } = await supabase
      .from('guardian_links')
      .select('student_id')
      .eq('status', 'accepted');

    const ids = ((links as { student_id: string }[]) ?? []).map((l) => l.student_id);
    if (!ids.length) {
      setChildren([]);
      setLoading(false);
      return;
    }

    const { data } = await supabase.from('profiles').select('*').in('id', ids).order('full_name');
    setChildren((data as Profile[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { children, loading, reload };
}

/**
 * Makes sure today's trips exist before a screen tries to show them.
 *
 * Blueprint §3: "the system creates daily trips from the appropriate templates".
 * Ideally a nightly pg_cron job does this (see SETUP.md); calling it here as
 * well means the pilot works even if cron was never enabled. It is idempotent,
 * so calling it twice costs nothing.
 */
export async function ensureTodaysTrips(date: string = today()) {
  await supabase.rpc('ensure_daily_trips', { target_date: date });
}
