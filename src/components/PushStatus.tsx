import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useAuth } from '../lib/auth';
import { notifyLocally, registerForPush } from '../lib/push';
import type { PushState } from '../lib/push';
import { Button, Card, Row, theme } from './ui';

/**
 * Whether real push notifications actually work on this device, and if not, why.
 *
 * This exists because the failure was completely silent. `registerForPush` used
 * to swallow every error and return null, so a family whose phone had never been
 * issued a push token saw alerts only when the app happened to be open — and had
 * no way of knowing that was happening. "Your van is due in 15 minutes" is
 * worthless as a notification you have to open the app to find.
 *
 * Shown on the screens where it matters (the student's and parent's Today
 * screens, and the driver's trip list). Says nothing at all when push is
 * working, because a permanent green tick is just furniture.
 */
export function PushStatus({ compact = false }: { compact?: boolean }) {
  const { session, profile } = useAuth();
  const [state, setState] = useState<PushState | null>(null);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);

  const check = useCallback(async () => {
    if (!session?.user.id || profile?.status !== 'active') return;
    setState(await registerForPush(session.user.id));
  }, [session?.user.id, profile?.status]);

  useEffect(() => {
    check();
  }, [check]);

  // Working, or not yet known. Either way there is nothing useful to say.
  if (!state || state.ok) return null;

  // On web there is nothing the person can do about it, and the staff portal is
  // deliberately a browser app — so this is a fact, not a fault.
  if (state.reason === 'web' && compact) return null;

  const actionable = state.reason === 'denied' || state.reason === 'no-project-id';

  return (
    <Card style={actionable ? styles.warn : styles.quiet}>
      <Text style={actionable ? styles.warnTitle : styles.quietTitle}>
        {state.reason === 'denied'
          ? '🔕 Notifications are switched off'
          : state.reason === 'no-project-id'
            ? '⚠ Push is not configured in this build'
            : state.reason === 'web'
              ? 'ℹ️ This is the web app'
              : state.reason === 'simulator'
                ? 'ℹ️ Simulator'
                : '⚠ Push is not working'}
      </Text>
      <Text style={styles.body}>{state.message}</Text>

      {state.reason === 'denied' ? (
        <Row style={styles.wrap}>
          <Button label="Try again" variant="secondary" onPress={check} />
          <Button
            label={tested ? 'Sent — check your notifications' : 'Send me a test'}
            variant="ghost"
            loading={testing}
            onPress={async () => {
              setTesting(true);
              const sent = await notifyLocally(
                'Bus Tracker test',
                'If you can see this on your lock screen, notifications are working.',
              );
              setTesting(false);
              setTested(sent);
            }}
          />
        </Row>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  warn: { borderColor: theme.warn },
  quiet: { backgroundColor: theme.surfaceAlt },
  warnTitle: { fontSize: 15, fontWeight: '700', color: theme.warn },
  quietTitle: { fontSize: 15, fontWeight: '700', color: theme.muted },
  body: { fontSize: 13, color: theme.muted, lineHeight: 19 },
  wrap: { flexWrap: 'wrap' },
});
