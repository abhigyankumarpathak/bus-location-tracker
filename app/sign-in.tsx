import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, View, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { removalNoticeFor, useAuth } from '../src/lib/auth';
import { Button, Card, ErrorText, Field, Screen, Title, theme } from '../src/components/ui';

export default function SignIn() {
  const { signIn, signInWith } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [social, setSocial] = useState<'google' | 'apple' | null>(null);

  /**
   * Social sign-in. First use creates the account; the profile and role are
   * still claimed with an invite afterwards, on the screen index.tsx routes to
   * when it finds a session with no profile behind it.
   */
  async function onSocial(provider: 'google' | 'apple') {
    setError('');
    setNotice('');
    setSocial(provider);
    try {
      await signInWith(provider);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in.');
    } finally {
      setSocial(null);
    }
  }

  async function onSubmit() {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await signIn(email, password);
      // Routing is handled by the guards in _layout.tsx once the session lands.
    } catch (e) {
      // A failed login might not be a typo — an admin may have removed the
      // account and left a message. Check before blaming the password.
      const removal = await removalNoticeFor(email).catch(() => null);
      if (removal) setNotice(removal);
      else setError(e instanceof Error ? e.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <Text style={styles.emoji}>🚌</Text>
          <Title sub="From planned pickup to confirmed safe drop-off.">School Transport</Title>
        </View>

        {/*
          Social sign-in FIRST, because it is what most families will use, and
          the password form beneath it is the fallback rather than the default.

          Apple is offered wherever Google is. App Store guideline 4.8 requires
          Sign in with Apple in any iOS app that offers another provider's
          sign-in, so on iOS this is not optional -- and it would be strange to
          hide it everywhere else.
        */}
        <Card>
          <Button
            label="Continue with Google"
            onPress={() => onSocial('google')}
            loading={social === 'google'}
            disabled={social !== null}
          />
          <Button
            label="Continue with Apple"
            variant="secondary"
            onPress={() => onSocial('apple')}
            loading={social === 'apple'}
            disabled={social !== null}
          />
          <Text style={styles.fine}>
            No password to remember. You still need an invite code from the transport office the
            first time — it decides what you can see.
          </Text>
        </Card>

        <Text style={styles.or}>or with a password</Text>

        <Card>
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            placeholder="you@school.edu"
          />
          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="off"
            textContentType="none"
            importantForAutofill="no"
            passwordRules=""
            placeholder="••••••••"
          />

          {notice ? (
            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>Your account was removed</Text>
              <Text style={styles.noticeBody}>{notice}</Text>
            </View>
          ) : null}

          <ErrorText>{error}</ErrorText>

          <Button
            label="Sign in"
            onPress={onSubmit}
            loading={busy}
            disabled={!email.trim() || !password}
          />
        </Card>

        <Button
          label="I have an invite code"
          variant="ghost"
          onPress={() => router.push('/sign-up')}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', gap: 8, paddingVertical: 28 },
  emoji: { fontSize: 56 },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17, textAlign: 'center' },
  or: { fontSize: 12, color: theme.faint, textAlign: 'center', marginVertical: 4 },
  notice: {
    backgroundColor: '#2A1D1D',
    borderColor: theme.danger,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  noticeTitle: { color: theme.danger, fontWeight: '700', fontSize: 14 },
  noticeBody: { color: theme.text, fontSize: 14, lineHeight: 20 },
});
