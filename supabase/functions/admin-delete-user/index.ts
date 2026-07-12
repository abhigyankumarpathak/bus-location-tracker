// admin-delete-user — the correction mechanism for self-selected roles.
//
// Because anyone can sign up as a student, parent, or driver, an admin needs a
// way to remove an account that is wrong (a "driver" who doesn't drive for the
// school, say) and tell the person to start over. That's this.
//
// Deleting an auth user requires the service-role key, which must never be in
// the app bundle — hence a server-side function. The caller's own JWT is
// checked first, so possessing the URL isn't enough.
//
// The "please sign up again" message is stored against the person's EMAIL
// rather than sent as an in-app notification, because deleting the account
// cascades their notifications away with it. The sign-in screen surfaces the
// message when they next try to log in.

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

const DEFAULT_REASON =
  'An administrator removed your account because the details did not check out. ' +
  'Please sign up again and pick the role that matches you.';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Not signed in.' }, 401);

  const caller = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user } } = await caller.auth.getUser();
  if (!user) return json({ error: 'Not signed in.' }, 401);

  const { data: callerProfile } = await caller
    .from('profiles')
    .select('role, status')
    .eq('id', user.id)
    .maybeSingle();

  // Admins only — NOT coordinators. Coordinators run the day; deleting an
  // account and everything attached to it is an administrator's call, and RLS
  // draws the same line on profiles.
  if (callerProfile?.role !== 'admin' || callerProfile.status !== 'active') {
    return json({ error: 'Administrators only.' }, 403);
  }

  let body: { user_id?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }

  const targetId = String(body.user_id ?? '').trim();
  const reason = String(body.reason ?? '').trim() || DEFAULT_REASON;

  if (!targetId) return json({ error: 'user_id is required' }, 400);
  if (targetId === user.id) {
    return json({ error: 'You cannot delete your own admin account.' }, 400);
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: target } = await admin
    .from('profiles')
    .select('email, role')
    .eq('id', targetId)
    .maybeSingle();

  if (!target) return json({ error: 'No such account.' }, 404);
  if (target.role === 'admin' || target.role === 'coordinator') {
    return json({ error: 'Staff accounts must be removed with SQL, not from the app.' }, 400);
  }

  // Record the notice BEFORE deleting: once the auth user is gone we no longer
  // have their email to key it to.
  if (target.email) {
    const { error: noticeError } = await admin.from('account_removals').insert({
      email: target.email,
      reason,
      removed_by: user.id,
    });
    if (noticeError) return json({ error: noticeError.message }, 500);
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(targetId);
  if (deleteError) return json({ error: deleteError.message }, 500);

  return json({ ok: true, email: target.email, reason });
});
