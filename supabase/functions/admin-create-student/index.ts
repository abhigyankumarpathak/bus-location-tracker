// admin-create-student — a roster record for a rider who will never sign in.
//
// Self-scan assumes a phone. The students who do not have one cannot create an
// account, so before this they could not exist in the system at all: not on a
// monitor's list, not in the register, and invisible to their own parents. The
// children most in need of somebody checking were the only ones nobody could.
//
// SO STAFF CREATE THE ACCOUNT. Name only. No email to collect, no password to
// transmit, and the student never signs in — but they get a real `profiles` row,
// which is what makes everything else work unchanged: guardians can be linked,
// the register counts them, monitors tick them off, and the history is theirs.
//
// IT REUSES THE INVITE PATH RATHER THAN BYPASSING IT.
//
// The obvious shortcut is a `staff_created: true` flag in the signup metadata
// that handle_new_user() honours. That would be a privilege-escalation hole:
// supabase.auth.signUp() lets ANY client set raw_user_meta_data, so anybody
// could sign themselves up with that flag and whatever role they fancied.
//
// Instead this mints a single-use invite server-side and redeems it in the same
// call. handle_new_user() is untouched, every check it already makes still runs,
// and there is no new door — only a new way to walk through the existing one.
//
//   POST { full_name: "Sai Durasala" }   ->   { id, email }

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

/**
 * A placeholder address on a reserved TLD.
 *
 * `.invalid` is set aside by RFC 2606 and can never resolve, so this cannot
 * silently mail a real person — which a typo'd real-looking domain very much
 * could. Supabase needs *an* email; nothing is ever sent to it.
 */
function placeholderEmail(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '').slice(0, 32);
  const rand = crypto.randomUUID().slice(0, 8);
  return `${slug || 'rider'}.${rand}@no-phone.invalid`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
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

  // Staff, not admins only. Adding a rider to the roll is day-to-day office
  // work, unlike deleting an account — and RLS draws the same line.
  const isStaff =
    (callerProfile?.role === 'admin' || callerProfile?.role === 'coordinator') &&
    callerProfile?.status === 'active';
  if (!isStaff) return json({ error: 'The transport office only.' }, 403);

  let body: { full_name?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }

  const fullName = String(body.full_name ?? '').trim();
  if (fullName.length < 2) return json({ error: 'A name is required.' }, 400);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const email = placeholderEmail(fullName);

  // 1. Mint the invite. Locked to this address so it cannot be redeemed by
  //    anybody else even in the seconds before it is used.
  const { data: invite, error: inviteError } = await admin
    .from('invites')
    .insert({ role: 'student', full_name: fullName, email, created_by: user.id,
              note: 'Roster record for a rider without a phone.' })
    .select('code')
    .single();

  if (inviteError) return json({ error: inviteError.message }, 500);

  // 2. Redeem it. handle_new_user() runs exactly as it does for a real signup:
  //    it validates the code, assigns the role FROM THE INVITE, and creates the
  //    profile and students rows.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    // Never used. There is no sign-in for this account, and no way to discover
    // this value — it is not returned and not stored anywhere readable.
    password: crypto.randomUUID() + crypto.randomUUID(),
    email_confirm: true,
    user_metadata: { invite_code: invite.code, full_name: fullName },
  });

  if (createError) {
    // Do not leave a live invite behind for an account that was never made.
    await admin.from('invites').update({ revoked_at: new Date().toISOString() })
      .eq('code', invite.code);
    return json({ error: createError.message }, 500);
  }

  const id = created.user?.id;
  if (!id) return json({ error: 'The account was not created.' }, 500);

  // 3. The whole reason they are being created this way.
  await admin.from('students')
    .upsert({ student_id: id, has_phone: false }, { onConflict: 'student_id' });

  return json({ ok: true, id, email, full_name: fullName });
});
