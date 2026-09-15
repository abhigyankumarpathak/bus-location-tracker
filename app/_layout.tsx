import { useEffect } from 'react';
import { Platform } from 'react-native';
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
import { Loading, theme } from '../src/components/ui';

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
  const { session, profile, loading, staffUnlocked, isStaff, profileMissing } = useAuth();

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

  // A session with no profile behind it is no longer a dead end. It is now the
  // NORMAL state after a social sign-in: Google vouched for the person, and the
  // invite that decides their role has not been claimed yet. The claim screen
  // below handles that, and still offers sign-out for the other case — an
  // account deleted underneath a stored session — which used to get a spinner
  // forever and then, briefly, a dedicated card. One screen covers both.
  if (loading || (session && !profile && !profileMissing)) return <Loading />;

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

      {/* Signed in, no profile: claim the invite. The only route that exists
          until it is claimed, so RLS-empty screens are never even mounted. */}
      <Stack.Protected guard={!!session && profileMissing}>
        <Stack.Screen name="claim" options={{ headerShown: false }} />
      </Stack.Protected>

      <Stack.Protected guard={!!session && !!profile && profile.status !== 'active'}>
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
