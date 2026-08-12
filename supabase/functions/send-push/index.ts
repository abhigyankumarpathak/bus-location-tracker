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

  // S6: every outcome is RECORDED on the notification row, including the
  // failures. Before this, a user with no push token produced no row, no retry
  // and no trace — so "we sent it" was unfalsifiable, and the only backstop was
  // an in-app inbox that needs the app opened. For an URGENT could-not-drop-off,
  // that is not a delivery mechanism.
  const mark = async (
    state: 'sent' | 'no_token' | 'failed',
    detail: string | null,
  ) => {
    await admin
      .from('notifications')
      .update({
        delivery_state: state,
        delivery_detail: detail,
        delivered_at: state === 'sent' ? new Date().toISOString() : null,
      })
      .eq('id', record.id);
  };

  const { data: profile } = await admin
    .from('profiles')
    .select('expo_push_token')
    .eq('id', record.user_id)
    .maybeSingle();

  // No token means this user has never opened the app on a device that granted
  // notification permission. Still not an error — but it IS now a fact on the
  // record, so the office can see who is unreachable before it matters.
  if (!profile?.expo_push_token) {
    await mark('no_token', 'No push token on file for this user.');
    return json({ ok: true, delivered: false, reason: 'no push token on file' });
  }

  // The two urgent kinds ring through a silenced phone. Everything else does not.
  const urgent =
    record.kind === 'emergency' ||
    record.kind === 'unable_to_drop_off' ||
    record.kind === 'no_show_after_checkin';

  // An arrival alert whose whole job is "start walking to the hub now" is
  // useless as a silent banner on a phone in a pocket. It gets a sound and high
  // priority — not because it is urgent, but because it is TIME-CRITICAL, and a
  // notification that arrives after the van has gone is worse than none.
  const timeCritical = record.kind === 'arrival' || record.kind === 'delay';

  // Android 8+ routes by channel, and the channel is what decides whether a
  // family can mute the routine pings without also muting the urgent ones. The
  // app creates all three at registration (see src/lib/push.ts).
  const channelId = urgent ? 'urgent' : record.kind === 'arrival' ? 'arrivals' : 'default';

  let response: Response;
  try {
    response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        to: profile.expo_push_token,
        title: record.title,
        body: record.body,
        sound: urgent || timeCritical ? 'default' : null,
        priority: urgent || timeCritical ? 'high' : 'normal',
        channelId,
        // iOS: without this an urgent alert is silenced by a Focus mode, which
        // is exactly when somebody most needs to be interrupted.
        ...(urgent ? { interruptionLevel: 'time-sensitive' } : {}),
        data: { notification_id: record.id, kind: record.kind },
      }),
    });
  } catch (err) {
    await mark('failed', `Could not reach the push service: ${String(err)}`);
    return json({ ok: false, delivered: false, error: String(err) }, 502);
  }

  const result = await response.json();

  // Expo answers 200 with a per-message error for a token it has retired, so the
  // HTTP status alone is not the answer.
  const ticketError = result?.data?.status === 'error' ? result?.data?.message : null;

  if (!response.ok || ticketError) {
    await mark('failed', ticketError ?? `Push service returned ${response.status}.`);
    return json({ ok: false, delivered: false, result });
  }

  await mark('sent', null);
  return json({ ok: true, delivered: true, result });
});
