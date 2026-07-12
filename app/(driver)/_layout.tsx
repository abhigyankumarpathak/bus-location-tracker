import { Stack } from 'expo-router';
import { theme } from '../../src/components/ui';

/**
 * The driver gets a stack, not tabs. Blueprint §5.1: "Buttons must be large and
 * simple. The app should discourage interaction while the vehicle is moving." A
 * tab bar invites browsing; a driver should be on exactly one screen — the trip
 * they are running — and get back out of it deliberately.
 */
export default function DriverLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.bg },
        headerTintColor: theme.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: theme.bg },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="trip/[id]" options={{ title: 'Trip' }} />
    </Stack>
  );
}
