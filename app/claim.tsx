import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../src/lib/auth';
import { clearSignup, readSignup } from '../src/lib/pending-signup';
import { Button, Card, ErrorText, Field, Screen, Title, theme } from '../src/components/ui';

/**
 * The second half of a social sign-in.
 *
 * The person is signed in — Google or Apple vouched for them — but the account
 * has no profile, so it has no role and RLS lets it read nothing. This is where
 * they present the invite code the transport office gave them, and
 * claim_invite() turns it into a profile with the role the invite carries.
 *
 * It exists because the alternative was worse. A password signup can carry the
 * code in its metadata and be checked at creation; an OAuth signup arrives
 * from the provider with nothing attached. The shortcut would be to create
 * social users as students by default, and that would let anybody with a Google
 * account walk into the register. So: sign in however you like, then prove
 * somebody invited you. Nobody picks their own role.
 */
export default function ClaimInvite() {
  const { session, claimInvite, signOut } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const tried = useRef(false);

  /**
   * Somebody who came here from sign-up already typed all of this before Google
   * took the page away. Apply it rather than asking again — being made to
   * re-enter a code you just entered reads as the app having lost your place,
   * which is exactly what happened and exactly what should not show.
   *
   * Runs once. A stash that fails (expired invite, wrong Google account) falls
   * through to the form below with the reason, and is cleared so the failure
   * cannot repeat on every render.
   */
  useEffect(() => {
    if (tried.current) return;
    tried.current = true;

    const pending = readSignup();
    if (!pending) return;

    setCode(pending.code);
    setBusy(true);
    claimInvite(pending.code, { fullName: pending.fullName, phone: pending.phone })
      .then(clearSignup)
      .catch((e: unknown) => {
        clearSignup();
        setError(e instanceof Error ? e.message : 'That code did not work.');
      })
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit() {
    setError('');
    setBusy(true);
    try {
      await claimInvite(code);
      // index.tsx re-reads the profile and routes by role from here.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That code did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <Text style={styles.emoji}>🎟️</Text>
          <Title sub={session?.user.email ?? undefined}>One more step</Title>
        </View>

        <Card>
          <Text style={styles.body}>
            You are signed in, but this account is not attached to anyone yet. Enter the invite
            code the transport office gave you — it decides whether you see a student's, a
            parent's, or the office's screens.
          </Text>
          <Field
            label="Invite code"
            value={code}
            onChangeText={setCode}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="BUS-XXXX-XXXX"
          />
          <ErrorText>{error}</ErrorText>
          <Button label="Continue" onPress={onSubmit} loading={busy} disabled={!code.trim()} />
          <Text style={styles.fine}>
            No code? Ask the transport office. They issue one per person, and it is the only way
            an account gets a role.
          </Text>
        </Card>

        <Button label="Sign out" variant="ghost" onPress={signOut} />
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', gap: 8, paddingVertical: 28 },
  emoji: { fontSize: 56 },
  body: { fontSize: 14, color: theme.text, lineHeight: 20 },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
});
