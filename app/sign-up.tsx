import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { lookupInvite, useAuth } from '../src/lib/auth';
import { stashSignup } from '../src/lib/pending-signup';
import type { InviteDetails } from '../src/lib/auth';
import { Badge, Button, Card, ErrorText, Field, Screen, Title, theme } from '../src/components/ui';

/**
 * Signing up (blueprint §6.1).
 *
 *   Admin creates the user → hands them a code → they sign up → role is assigned
 *
 * There is no role picker, because the person does not get a say. The invite
 * carries the role, and the signup trigger reads it off the invite row and
 * ignores anything this screen sends. A code is checked BEFORE the password
 * form appears, so a wrong one fails immediately rather than after they have
 * typed everything.
 */
const ROLE_BLURB: Record<string, string> = {
  student: 'See today’s trip, check in at your hub, and set your club plans.',
  parent: 'Follow your child from pickup to safe drop-off, and report changes.',
  driver: 'Run your assigned trips and record boarding and drop-off.',
  coordinator: 'Run daily operations and resolve exceptions.',
  admin: 'Full access, including configuration and inviting others.',
};

export default function SignUp() {
  const { signUp, signInWith } = useAuth();

  const [code, setCode] = useState('');
  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [checking, setChecking] = useState(false);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState(false);
  const [done, setDone] = useState(false);

  async function check() {
    setError('');
    setChecking(true);
    try {
      const details = await lookupInvite(code);
      if (!details.valid) {
        setError(details.reason ?? 'That invite code is not valid.');
        setInvite(null);
        return;
      }
      setInvite(details);
      // The office already knows who they are — prefill it.
      if (details.full_name) setFullName(details.full_name);
      if (details.email) setEmail(details.email);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check that code.');
    } finally {
      setChecking(false);
    }
  }

  /**
   * Finish with Google instead of a password.
   *
   * The code and the details are stashed FIRST, because on web the next line
   * navigates the page away and takes React state with it. They come back
   * holding a session and no profile, and app/claim.tsx applies the stash
   * without making them type any of it twice.
   */
  async function onGoogle() {
    setError('');
    stashSignup({ code: code.trim(), fullName: fullName.trim(), phone: phone.trim() });
    setGoogle(true);
    try {
      await signInWith('google');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open Google sign-in.');
    } finally {
      setGoogle(false);
    }
  }

  async function onSubmit() {
    setError('');
    setBusy(true);
    try {
      await signUp({ email, password, fullName, phone, inviteCode: code });
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the account.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Screen>
        <Title sub="You can sign in straight away — there is nothing to wait for.">
          Account created
        </Title>
        <Card>
          <Text style={styles.hint}>
            The transport office invited you, so your account is already approved and your role is
            set. Sign in and you will land on the right screens.
          </Text>
        </Card>
        <Button label="Go to sign in" onPress={() => router.replace('/sign-in')} />
      </Screen>
    );
  }

  // An email-locked invite must be redeemed by that address, so don't let them edit it.
  const emailLocked = Boolean(invite?.email);
  // Google needs everything EXCEPT a password — that is the point of it.
  const canFinish = !!invite && fullName.trim().length > 1;
  const canSubmit = canFinish && email.includes('@') && password.length >= 6;

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Title sub="The transport office gives you a code. It decides who you are in the app.">
          Join with an invite
        </Title>

        <Card>
          <Field
            label="Invite code"
            value={code}
            onChangeText={(v) => {
              setCode(v.toUpperCase());
              // A changed code invalidates whatever the last one said.
              if (invite) setInvite(null);
            }}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!invite}
            placeholder="BUS-XXXX-XXXX"
            style={styles.code}
          />

          {!invite ? (
            <>
              <ErrorText>{error}</ErrorText>
              <Button
                label="Check code"
                onPress={check}
                loading={checking}
                disabled={code.trim().length < 6}
              />
              <Text style={styles.hint}>
                No code? You cannot sign up without one — ask the school transport office to invite
                you.
              </Text>
            </>
          ) : (
            <View style={styles.confirmed}>
              <View style={styles.grow}>
                <Text style={styles.confirmedName}>{invite.full_name || 'Invited user'}</Text>
                <Text style={styles.hint}>
                  {ROLE_BLURB[invite.role ?? ''] ?? 'Invited to the app.'}
                </Text>
              </View>
              <Badge label={invite.role ?? ''} tone="success" />
            </View>
          )}
        </Card>

        {invite ? (
          <Card>
            <Field
              label="Full name"
              value={fullName}
              onChangeText={setFullName}
              autoComplete="name"
              placeholder="Alex Rivera"
            />
            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              editable={!emailLocked}
              placeholder="you@school.edu"
            />
            {emailLocked ? (
              <Text style={styles.hint}>
                This invite was issued to {invite.email} and can only be used with that address.
              </Text>
            ) : null}
            <Field
              label="Phone"
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              autoComplete="tel"
              placeholder="(555) 010-0100"
            />
            <ErrorText>{error}</ErrorText>

            {/*
              Google FIRST, and the password below it. Most people should take
              the top one — nothing to remember, and recovery becomes Google's
              rather than an office running a database command. The password is
              here because not everybody has a Google account, and locking those
              families out to save a button is not a trade worth making.
            */}
            <Button
              label="Finish with Google"
              onPress={onGoogle}
              loading={google}
              disabled={!canFinish || busy}
            />
            <Text style={styles.hint}>
              No password to remember. You will pick your Google account and come straight back.
            </Text>

            <Text style={styles.or}>or set a password</Text>

            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="off"
              textContentType="none"
              importantForAutofill="no"
              passwordRules=""
              placeholder="At least 6 characters"
            />

            <Button
              label={`Create ${invite.role} account`}
              variant="secondary"
              onPress={onSubmit}
              loading={busy}
              disabled={!canSubmit || google}
            />
          </Card>
        ) : null}

        <Button label="I already have an account" variant="ghost" onPress={() => router.back()} />
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  code: { fontSize: 20, letterSpacing: 2, fontWeight: '700' },
  hint: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  or: { fontSize: 12, color: theme.faint, textAlign: 'center', marginTop: 4 },
  confirmed: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: theme.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.success,
    borderRadius: 12,
    padding: 14,
  },
  confirmedName: { fontSize: 16, fontWeight: '700', color: theme.text },
  grow: { flex: 1 },
});
