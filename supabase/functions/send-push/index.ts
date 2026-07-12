// send-push — turns a row in `notifications` into an actual push notification.
//
// Wired up as a Supabase Database Webhook on INSERT into `notifications` (see
// SETUP.md). That means every path that creates a notification — the boarding
// trigger, a driver reporting a delay, an admin announcement — gets push for
// free, without any of them knowing this function exists.
//
// The webhook is configured to send the service-role key as its bearer token,
// and we check it, because this function is otherwise an open "send a push to
// any user" endpoint.

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

interface NotificationRow {
  id: string;
  user_id: string;
  title: string;
  body: string;
  kind: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const bearer = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (bearer !== serviceKey) return json({ error: 'Forbidden' }, 403);

  let payload: { record?: NotificationRow };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }

  const record = payload.record;
  if (!record?.user_id) return json({ error: 'No notification record in payload' }, 400);

  const { createClient } = await import('jsr:@supabase/supabase-js@2');
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey);

  const { data: profile } = await admin
    .from('profiles')
    .select('expo_push_token')
    .eq('id', record.user_id)
    .maybeSingle();

  // No token just means this user has never opened the app on a device that
  // granted notification permission. Not an error — they'll still see the
  // notification in-app.
  if (!profile?.expo_push_token) {
    return json({ ok: true, delivered: false, reason: 'no push token on file' });
  }

  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      to: profile.expo_push_token,
      title: record.title,
      body: record.body,
      sound: record.kind === 'emergency' ? 'default' : null,
      priority: record.kind === 'emergency' ? 'high' : 'normal',
      data: { notification_id: record.id, kind: record.kind },
    }),
  });

  const result = await response.json();
  return json({ ok: response.ok, delivered: response.ok, result });
});
