import { StyleSheet, Text, View } from 'react-native';
import { Card, Screen, Title, theme } from './ui';

/**
 * Shown when EXPO_PUBLIC_SUPABASE_URL / _PUBLISHABLE_KEY are missing.
 *
 * A fresh clone has no .env, and crashing on that is hostile — the person
 * hasn't done anything wrong, they just haven't finished setup. So the app
 * boots and tells them what to do.
 */
export function SetupNeeded() {
  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.emoji}>🔌</Text>
        <Title sub="The app is running, but it has nowhere to store anything yet.">
          Connect Supabase
        </Title>
      </View>

      <Card>
        <Step n={1} text="Create a project at supabase.com (the free tier is plenty)." />
        <Step n={2} text="Open the SQL Editor and run supabase/schema.sql, then supabase/seed.sql." />
        <Step n={3} text="Copy .env.example to .env and paste in your project URL and publishable key." />
        <Step n={4} text="Restart the bundler with: npx expo start --clear" />
      </Card>

      <Card>
        <Text style={styles.note}>
          The full walkthrough — including the Edge Functions, the admin password, and how to make
          yourself an administrator — is in supabase/SETUP.md.
        </Text>
      </Card>
    </Screen>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <View style={styles.step}>
      <View style={styles.bullet}>
        <Text style={styles.bulletText}>{n}</Text>
      </View>
      <Text style={styles.stepText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', gap: 8, paddingVertical: 28 },
  emoji: { fontSize: 52 },
  step: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  bullet: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: theme.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bulletText: { color: theme.accentText, fontWeight: '700', fontSize: 13 },
  stepText: { flex: 1, color: theme.text, fontSize: 14, lineHeight: 21 },
  note: { color: theme.muted, fontSize: 13, lineHeight: 20 },
});
