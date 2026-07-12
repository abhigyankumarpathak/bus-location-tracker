// ingest-location — the GPS door for anything that is not the driver's phone.
//
// You told me you don't know how the bus GPS is wired up yet, so this is
// deliberately undemanding: any device that can make an HTTPS POST and knows a
// vehicle's device_key can report a position. It does not care what hardware
// you end up buying.
//
//   curl -X POST "$SUPABASE_URL/functions/v1/ingest-location" \
//     -H 'Content-Type: application/json' \
//     -d '{"device_key":"<key>","lat":37.3349,"lng":-122.0090}'
//
// Auth is the device_key alone (no user JWT), because trackers can't log in.
// That key is the credential — treat it like a password, and rotate it with
//   update vehicles set device_key = encode(gen_random_bytes(24),'hex') where id = ...;
//
// Rows land in the same vehicle_locations table the driver app writes to, so
// the map never learns which source a fix came from.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

// Trackers are inconsistent about what they call things. Accept the spellings
// that are actually common in the wild rather than forcing one shape.
function coerce(payload: Record<string, unknown>) {
  const num = (...keys: string[]) => {
    for (const k of keys) {
      const v = payload[k];
      if (v === undefined || v === null || v === '') continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  };

  return {
    device_key: String(payload.device_key ?? payload.deviceKey ?? payload.key ?? '').trim(),
    lat: num('lat', 'latitude', 'y'),
    lng: num('lng', 'lon', 'long', 'longitude', 'x'),
    heading: num('heading', 'bearing', 'course'),
    speed: num('speed', 'velocity'),
    recorded_at: payload.recorded_at ?? payload.timestamp ?? payload.time ?? null,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }

  const fix = coerce(payload);

  if (!fix.device_key) return json({ error: 'device_key is required' }, 400);
  if (fix.lat === undefined || fix.lng === undefined) {
    return json({ error: 'lat and lng are required' }, 400);
  }
  if (fix.lat < -90 || fix.lat > 90 || fix.lng < -180 || fix.lng > 180) {
    return json({ error: 'lat/lng out of range' }, 400);
  }

  // Service role: trackers have no user session, so RLS cannot be the check
  // here. The device_key lookup below is the authorization.
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // device_key lives in vehicle_devices, not vehicles — `vehicles` is readable
  // by every signed-in user (students browse it to pick their bus), so a key
  // stored there would be readable by every student in the school.
  const { data: device, error: lookupError } = await admin
    .from('vehicle_devices')
    .select('vehicle_id')
    .eq('device_key', fix.device_key)
    .maybeSingle();

  if (lookupError) return json({ error: lookupError.message }, 500);
  if (!device) return json({ error: 'Unknown device_key' }, 401);

  const vehicle = { id: device.vehicle_id as string };

  // Attach the fix to the vehicle's currently running trip, if there is one, so
  // reports can tie a position back to a run. A tracker that reports outside of
  // any trip still gets stored, just without a trip_id.
  const { data: trip } = await admin
    .from('trips')
    .select('id, routes!inner(vehicle_id)')
    .eq('status', 'active')
    .eq('routes.vehicle_id', vehicle.id)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const recordedAt = fix.recorded_at ? new Date(fix.recorded_at as string) : new Date();

  const { error: insertError } = await admin.from('vehicle_locations').insert({
    vehicle_id: vehicle.id,
    trip_id: trip?.id ?? null,
    lat: fix.lat,
    lng: fix.lng,
    heading: fix.heading ?? null,
    speed: fix.speed ?? null,
    source: 'device',
    recorded_at: Number.isNaN(recordedAt.valueOf()) ? new Date().toISOString() : recordedAt.toISOString(),
  });

  if (insertError) return json({ error: insertError.message }, 500);

  return json({ ok: true, vehicle_id: vehicle.id, trip_id: trip?.id ?? null });
});
