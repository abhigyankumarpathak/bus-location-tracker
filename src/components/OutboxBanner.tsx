import { StyleSheet, Text, View } from 'react-native';
import { alert } from '../lib/alert';
import { discard, retryFailed, useOutbox } from '../lib/outbox';
import { Button, Card, Row, theme } from './ui';

/**
 * "3 actions not yet saved."
 *
 * C3's fourth requirement, and the one the plan is bluntest about: *silence here
 * is the bug*. An offline queue that hides is worse than no queue, because the
 * driver believes the record is complete and the office believes it too.
 *
 * Two states, deliberately worded differently:
 *
 * PENDING is not an error. The van is in a dead spot, the writes are on the
 * phone, and they will land. Saying "failed to save" here would teach a driver to
 * re-tap everything and generate duplicate work — so this is amber and it says
 * what will happen without asking for anything.
 *
 * FAILED is the server having refused, which means a fact about a child did not
 * get recorded and nobody except this driver knows. That is red, it names each
 * one, and it does not go away on its own.
 */
export function OutboxBanner() {
  const { actions, pending, failed, connection } = useOutbox();

  if (!pending && !failed) return null;

  const stuck = actions.filter((a) => a.state === 'failed');

  return (
    <>
      {pending ? (
        <Card style={styles.pending}>
          <Row style={styles.between}>
            <Text style={styles.pendingTitle}>
              {pending === 1 ? '1 action not yet saved' : `${pending} actions not yet saved`}
            </Text>
            <Text style={styles.dot}>{connection === 'offline' ? '○ No signal' : '◌ Sending'}</Text>
          </Row>
          <Text style={styles.body}>
            They are recorded on this phone and will send themselves when you have signal. Keep
            driving — you do not need to tap anything again, and nothing is lost if the app closes.
          </Text>
        </Card>
      ) : null}

      {failed ? (
        <Card style={styles.failed}>
          <Text style={styles.failedTitle}>
            {failed === 1
              ? '1 action was refused and is NOT recorded'
              : `${failed} actions were refused and are NOT recorded`}
          </Text>
          <Text style={styles.body}>
            The server rejected these. Nobody else knows about them. Call the transport office
            before you finish the route.
          </Text>

          {stuck.map((a) => (
            <View key={a.id} style={styles.item}>
              <Text style={styles.itemLabel}>{a.label}</Text>
              <Text style={styles.itemWhen}>
                {new Date(a.clientTs).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
                {a.error ? ` — ${a.error}` : ''}
              </Text>
              <Button
                label="Discard this one"
                variant="ghost"
                onPress={() =>
                  alert(
                    'Discard this record?',
                    `“${a.label}” will be thrown away and no record of it will exist anywhere. Only do this if the office has told you it is already sorted.`,
                    [
                      { text: 'Keep it', style: 'cancel' },
                      { text: 'Discard', style: 'destructive', onPress: () => discard(a.id) },
                    ],
                  )
                }
              />
            </View>
          ))}

          <Button label="Try all of them again" variant="secondary" onPress={retryFailed} />
        </Card>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  between: { justifyContent: 'space-between' },
  pending: { borderColor: theme.warn, backgroundColor: '#2A2312', gap: 8 },
  pendingTitle: { fontSize: 15, fontWeight: '700', color: theme.warn, flexShrink: 1 },
  dot: { fontSize: 12, color: theme.muted },
  failed: { borderColor: theme.danger, backgroundColor: '#2A1D1D', gap: 10 },
  failedTitle: { fontSize: 15, fontWeight: '700', color: theme.danger },
  body: { fontSize: 13, color: theme.text, lineHeight: 19 },
  item: {
    gap: 4,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  itemLabel: { fontSize: 14, fontWeight: '600', color: theme.text },
  itemWhen: { fontSize: 12, color: theme.faint, lineHeight: 17 },
});
