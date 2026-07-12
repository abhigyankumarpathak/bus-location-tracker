import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../src/lib/auth';
import { Button, Card, ErrorText, Field, Screen, Title, theme } from '../src/components/ui';

/**
 * The staff portal's second lock.
 *
 * The first lock is the account: `coordinator` and `admin` cannot be
 * self-selected (the signup trigger refuses them), so only an account promoted
 * by SQL gets this far. The second is this password, compared inside an Edge
 * Function against a secret that never ships in the app bundle.
 *
 * Not remembered. Close the app and you enter it again.
 */
export default function Unlock() {
  const { unlockStaff, signOut, profile } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setError('');
    setBusy(true);
    try {
      await unlockStaff(password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Incorrect portal password.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.emoji}>🔐</Text>
        <Title
          sub={`Signed in as ${profile?.full_name || profile?.email || 'staff'} · ${profile?.role}`}
        >
          Transport portal
        </Title>
      </View>

      <Card>
        <Field
          label="Portal password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoFocus
          autoComplete="off"
          textContentType="none"
          importantForAutofill="no"
          passwordRules=""
          placeholder="••••••••"
          onSubmitEditing={onSubmit}
        />
        <ErrorText>{error}</ErrorText>
        <Button label="Unlock" onPress={onSubmit} loading={busy} disabled={!password} />
        <Text style={styles.note}>
          Separate from your account password, and checked on the server.
        </Text>
      </Card>

      <Button label="Sign out" variant="ghost" onPress={signOut} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', gap: 8, paddingVertical: 32 },
  emoji: { fontSize: 52 },
  note: { fontSize: 12, color: theme.faint, lineHeight: 17 },
});
