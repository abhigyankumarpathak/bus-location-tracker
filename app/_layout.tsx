import { useEffect } from 'react';
import { Platform, Text, View } from 'react-native';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AuthProvider, useAuth } from '../src/lib/auth';
import { OrgProvider } from '../src/lib/org';
import { isConfigured } from '../src/lib/supabase';
import * as Notifications from 'expo-notifications';
import { registerForPush } from '../src/lib/push';
import { SetupNeeded } from '../src/components/SetupNeeded';
import { Button, Card, Loading, Screen, Title, theme } from '../src/components/ui';

/**
 * Role-based navigation (blueprint §1.1).
 *
 * `Stack.Protected` does not merely hide a section — a route whose guard is
 * false is never registered, so a parent cannot deep-link into the driver's
 * roster. That is the client half. RLS in Postgres is the half that matters and
 * holds even against a raw API call.
 *
 * Note the pending gate: every account starts unapproved (blueprint has the
 * admin creating users; you asked for self-signup plus admin approval, and this
 * is where the two meet). Until an admin approves them, the ONLY route that
 * exists is the waiting screen.
 */
function RootNavigator() {
  const { session, profile, loading, staffUnlocked, isStaff, profileMissing, signOut } = useAuth();

  useEffect(() => {
    if (session?.user.id && profile?.status === 'active') {
      // Fire and forget. The RESULT is surfaced by <PushStatus/> on the screens
      // where it matters — the failure used to be swallowed here and nobody,
      // including the family, ever learned that push was off.
      registerForPush(session.user.id);
    }
  }, [session?.user.id, profile?.status]);

  // Tapping a push should land you on the thing it is about. Without this a
  // notification just opens the app on whatever screen it was last on, which for
  // "URGENT — could not drop off" is the wrong screen at the worst moment.
  useEffect(() => {
    const role = profile?.role;
    // expo-notifications has no web implementation, and the staff portal is a
    // browser app by design (blueprint §7.3). Nothing to listen to there.
    if (!role || Platform.OS === 'web') return;

    const inbox =
      role === 'parent'
        ? '/(parent)/alerts'
        : role === 'coordinator' || role === 'admin'
          ? '/(staff)/notifications'
          : null;

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const kind = response.notification.request.content.data?.kind as string | undefined;

      // A driver's notifications are all about the run they are on.
      if (role === 'driver') {
        router.push('/(driver)');
        return;
      }
      // Everyone else: the urgent ones go to the inbox where they can be
      // acknowledged, which is the whole point of requiring an acknowledgement.
      if (inbox) router.push(inbox);
      else if (kind) router.push('/');
    });

    return () => sub.remove();
  }, [profile?.role]);

  // A stored session whose account no longer exists — deleted by an admin, or
  // left behind by a schema rebuild. Without this the app sits on a spinner
  // forever with no way out but deleting it.
  if (!loading && session && profileMissing) {
    return <OrphanedSession onSignOut={signOut} />;
  }

  if (loading || (session && !profile)) return <Loading />;

  const role = profile?.role;
  const active = profile?.status === 'active';

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.bg },
        headerTintColor: theme.text,
        contentStyle: { backgroundColor: theme.bg },
      }}
    >
      <Stack.Protected guard={!session}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="sign-up" options={{ title: 'Create account' }} />
      </Stack.Protected>

      <Stack.Protected guard={!!session && profile?.status !== 'active'}>
        <Stack.Screen name="pending" options={{ headerShown: false }} />
      </Stack.Protected>

      <Stack.Protected guard={active && role === 'student'}>
        <Stack.Screen name="(student)" options={{ headerShown: false }} />
      </Stack.Protected>

      <Stack.Protected guard={active && role === 'parent'}>
        <Stack.Screen name="(parent)" options={{ headerShown: false }} />
      </Stack.Protected>

      <Stack.Protected guard={active && role === 'driver'}>
        <Stack.Screen name="(driver)" options={{ headerShown: false }} />
      </Stack.Protected>

      {/* The staff portal needs BOTH a coordinator/admin account (grantable only
          by SQL) and the portal password. Until the password is entered this
          launch, the unlock screen is the only route that exists. */}
      <Stack.Protected guard={active && isStaff && !staffUnlocked}>
        <Stack.Screen name="unlock" options={{ headerShown: false }} />
      </Stack.Protected>

      <Stack.Protected guard={active && isStaff && staffUnlocked}>
        <Stack.Screen name="(staff)" options={{ headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
}

function OrphanedSession({ onSignOut }: { onSignOut: () => void }) {
  return (
    <Screen>
      <View style={{ alignItems: 'center', gap: 8, paddingVertical: 40 }}>
        <Text style={{ fontSize: 52 }}>🔑</Text>
        <Title sub="You are signed in, but the account behind this session no longer exists.">
          Session out of date
        </Title>
      </View>
      <Card>
        <Text style={{ color: theme.muted, fontSize: 14, lineHeight: 21 }}>
          This usually means an administrator removed the account, or the database was rebuilt
          while you were signed in. Sign out and sign in again — you will need an invite code if the
          account is really gone.
        </Text>
      </Card>
      <Button label="Sign out" onPress={onSignOut} />
    </Screen>
  );
}

export default function RootLayout() {
  if (!isConfigured) {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <SetupNeeded />
      </SafeAreaProvider>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <OrgProvider>
            <StatusBar style="light" />
            <RootNavigator />
          </OrgProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
