import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { UserIdentity } from '@supabase/supabase-js';
import { useAuth } from '../lib/auth';
import { alert } from '../lib/alert';
import { Badge, Button, Card, ErrorText, Row, SectionLabel, theme } from './ui';

/**
 * The ways into this account, and how to add or remove one.
 *
 * Mostly this is not needed. Supabase links a Google sign-in to an existing
 * account by itself when the provider hands back an email that matches and has
 * been VERIFIED by the provider — so somebody who signed up as jo@gmail.com and
 * later taps Continue with Google as jo@gmail.com keeps one account, and their
 * children with it. Unverified addresses are deliberately excluded from that,
 * because "trust me, this is my address" is how accounts get taken over.
 *
 * This screen is for the case that cannot cover: signed up with a school
 * address, wants to sign in with a personal Gmail. Different emails, same
 * person, and only the person already holding the session can vouch for that.
 *
 * Removing the last one is refused HERE as well as by the server, because an
 * error after the tap is a worse answer than a button that explains itself.
 */

const LABEL: Record<string, string> = {
  email: 'Email and password',
  google: 'Google',
  apple: 'Apple',
};

export function SignInMethods() {
  const { identities, linkProvider, unlinkProvider } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const has = (provider: string) => identities.some((i) => i.provider === provider);
  const only = identities.length <= 1;

  async function connect() {
    setError('');
    setBusy(true);
    try {
      await linkProvider('google');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect Google.');
    } finally {
      setBusy(false);
    }
  }

  function disconnect(identity: UserIdentity) {
    alert(
      `Remove ${LABEL[identity.provider] ?? identity.provider}?`,
      only
        ? 'This is the only way into your account, so it cannot be removed. Add another sign-in method first.'
        : 'You will sign in with your other method from now on. Nothing else about your account changes.',
      only
        ? [{ text: 'OK', style: 'cancel' }]
        : [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Remove',
              style: 'destructive',
              onPress: async () => {
                setError('');
                setBusy(true);
                try {
                  await unlinkProvider(identity);
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Could not remove it.');
                } finally {
                  setBusy(false);
                }
              },
            },
          ],
    );
  }

  return (
    <>
      <SectionLabel>How you sign in</SectionLabel>
      <Card>
        {identities.map((identity) => (
          <Row key={identity.identity_id ?? identity.provider} style={styles.between}>
            <View style={styles.grow}>
              <Text style={styles.name}>{LABEL[identity.provider] ?? identity.provider}</Text>
              {identity.identity_data?.email ? (
                <Text style={styles.fine}>{String(identity.identity_data.email)}</Text>
              ) : null}
            </View>
            {only ? (
              <Badge label="Only method" tone="neutral" />
            ) : (
              <Button
                label="Remove"
                variant="ghost"
                loading={busy}
                onPress={() => disconnect(identity)}
              />
            )}
          </Row>
        ))}

        {!has('google') ? (
          <>
            <Button label="Connect Google" variant="secondary" loading={busy} onPress={connect} />
            <Text style={styles.fine}>
              Then you can sign in either way. Useful if you signed up with one address and would
              rather use a different Google account.
            </Text>
          </>
        ) : null}

        {only ? (
          <Text style={styles.fine}>
            You have one way in, so it cannot be removed. Add another first.
          </Text>
        ) : null}

        <ErrorText>{error}</ErrorText>
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  between: { justifyContent: 'space-between' },
  grow: { flex: 1 },
  name: { fontSize: 15, fontWeight: '600', color: theme.text },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
});
