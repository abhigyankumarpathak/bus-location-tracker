import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../src/lib/auth';
import { Badge, Button, Card, Screen, Title, theme } from '../src/components/ui';

/**
 * The blocked-account screen.
 *
 * Since accounts are created by invite, nobody arrives here on signup any more —
 * a redeemed invite produces an `active` account, because the admin already
 * decided who this person is before the code was handed out.
 *
 * This screen exists for the two cases where an admin takes access away:
 * `suspended` (paused while they look into something) and `pending` (parked).
 * Neither can be lifted by the user: the guard_privileged_columns trigger blocks
 * anyone from changing their own status, and RLS gives a non-active profile
 * nothing at all — `my_role()` only returns a role for an ACTIVE account, so
 * every policy that depends on it fails closed.
 */
export default function Pending() {
  const { profile, signOut, refreshProfile } = useAuth();
  const suspended = profile?.status === 'suspended';

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.emoji}>{suspended ? '⏸️' : '⏳'}</Text>
        <Title
          sub={
            suspended
              ? 'An administrator has paused this account while they review it.'
              : 'An administrator has parked this account. It is not active yet.'
          }
        >
          {suspended ? 'Account on hold' : 'Account not active'}
        </Title>
      </View>

      <Card>
        <View style={styles.row}>
          <Text style={styles.label}>Name</Text>
          <Text style={styles.value}>{profile?.full_name || '—'}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Role</Text>
          <Badge label={profile?.role ?? '—'} tone="accent" />
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Status</Text>
          <Badge label={suspended ? 'Suspended' : 'Not active'} tone="danger" />
        </View>
      </Card>

      <Card>
        <Text style={styles.body}>
          Contact the school transport office. Only they can reactivate the account — you cannot do
          it from here, and neither can anyone else who is not an administrator.
        </Text>
      </Card>

      <Button label="Check again" variant="secondary" onPress={refreshProfile} />
      <Button label="Sign out" variant="ghost" onPress={signOut} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', gap: 8, paddingVertical: 32 },
  emoji: { fontSize: 52 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { fontSize: 14, color: theme.muted },
  value: { fontSize: 14, color: theme.text, fontWeight: '600' },
  body: { fontSize: 14, color: theme.muted, lineHeight: 21 },
});
