// admin-unlock — the admin portal's password gate.
//
// Two things must BOTH be true to get through:
//   1. The caller's JWT belongs to an account whose profile role is 'admin'.
//      Role is not self-selectable (the signup trigger rejects it), so this
//      can only be an account you promoted with SQL.
//   2. The submitted password matches the ADMIN_PORTAL_PASSWORD secret, which
//      lives in the function's environment and is never shipped in the app
//      bundle.
//
// The password alone is worthless without an admin account, and an admin
// account alone can't open the portal UI without the password. Note that RLS is
// what actually guards admin *data* — this function guards the door, not the
// vault. Someone who stole an admin JWT would still be stopped by the UI here,
// but not by the database, which is why the password is a second layer and not
// the only one.

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

// Compare digests rather than raw strings so the comparison doesn't leak the
// password's length or a matching prefix through timing.
async function constantTimeEqual(a: string, b: string) {
  const digest = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const expected = Deno.env.get('ADMIN_PORTAL_PASSWORD');
  if (!expected) {
    return json({ error: 'ADMIN_PORTAL_PASSWORD is not set on this project.' }, 500);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Not signed in.' }, 401);

  // Anon key + the caller's own JWT, so this client is subject to RLS and sees
  // exactly what the caller can see — nothing more.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: 'Not signed in.' }, 401);

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, status')
    .eq('id', user.id)
    .maybeSingle();

  let password = '';
  try {
    password = String(((await req.json()) as { password?: unknown }).password ?? '');
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }

  const passwordOk = await constantTimeEqual(password, expected);
  // Coordinators run the day and admins configure; both use the portal. Neither
  // role is self-selectable, so reaching this point already means someone with
  // database access granted it.
  const adminOk =
    (profile?.role === 'admin' || profile?.role === 'coordinator') &&
    profile.status === 'active';

  // Same message either way: don't reveal whether the account was the problem
  // or the password was.
  if (!adminOk || !passwordOk) {
    // Blunt the brute-force rate a little. Not a substitute for a real rate
    // limiter — if this portal ever faces the open internet, put one in front.
    await new Promise((r) => setTimeout(r, 700));
    return json({ error: 'Incorrect administrator password.' }, 403);
  }

  return json({ ok: true });
});
