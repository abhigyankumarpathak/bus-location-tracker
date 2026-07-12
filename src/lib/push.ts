import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from './supabase';

// expo-notifications has no web implementation. The staff portal runs in a
// browser (blueprint §7.3 wants the coordinator at a desk), so everything here
// no-ops there rather than throwing. Notifications are still written to the
// in-app inbox on every platform — push is the only thing web loses.
const supported = Platform.OS !== 'web';

if (supported) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
}

/** Shows a notification immediately, from the device itself. */
export async function notifyLocally(title: string, body: string) {
  if (!supported) return;
  const { granted } = await Notifications.getPermissionsAsync();
  if (!granted) return;
  await Notifications.scheduleNotificationAsync({
    content: { title, body },
    trigger: null,
  });
}

/**
 * Registers this device for push and stores the token on the user's profile,
 * where the send-push Edge Function looks for it.
 *
 * Returns null (without throwing) on a simulator or when permission is denied —
 * push is a nice-to-have, and the app works fine without it since every
 * notification is also written to the in-app inbox.
 */
export async function registerForPush(userId: string): Promise<string | null> {
  if (!supported || !Device.isDevice) return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Bus alerts',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    status = (await Notifications.requestPermissionsAsync()).status;
  }
  if (status !== 'granted') return null;

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    await supabase.from('profiles').update({ expo_push_token: token }).eq('id', userId);
    return token;
  } catch {
    // No EAS project configured yet is the usual cause. Not fatal.
    return null;
  }
}
