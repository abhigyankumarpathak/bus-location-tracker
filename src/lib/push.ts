import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from './supabase';

/**
 * Real push notifications — the ones that arrive when the app is closed.
 *
 * Every notification in this system is a row in `notifications`, and a Supabase
 * Database Webhook turns each INSERT into a call to the `send-push` Edge
 * Function. So the arrival alerts, the boarding confirmations, the watchdog
 * alerts and the urgent "could not drop off" all push through this one path
 * without any of them knowing it exists.
 *
 * That path has three separate ways to be silently off, which is why this file
 * reports WHY rather than returning null:
 *
 *   1. no EAS projectId  -> getExpoPushTokenAsync throws. This was the actual
 *      bug: app.json had no projectId at all, the throw was swallowed by a bare
 *      catch, and no device ever stored a token. Every notification landed in
 *      the in-app inbox and nowhere else.
 *   2. permission denied -> nothing to do but say so.
 *   3. no webhook configured in Supabase -> the token is fine and the row is
 *      written, but nothing ever calls send-push. Not detectable from here; see
 *      the delivery_state column, which stays 'pending' forever when this is
 *      the problem.
 *
 * expo-notifications has no web implementation. The staff portal runs in a
 * browser (blueprint §7.3), so everything here no-ops there rather than
 * throwing — web keeps the in-app inbox and loses only push.
 */

const supported = Platform.OS !== 'web';

/** Android 8+ requires channels. Separate ones so a family can mute the routine
 *  arrival pings WITHOUT also muting "we could not drop your child off". One
 *  channel for everything means the urgent ones get muted along with the noise. */
export const CHANNELS = {
  urgent: 'urgent',
  arrivals: 'arrivals',
  default: 'default',
} as const;

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

async function ensureChannels() {
  if (Platform.OS !== 'android') return;

  await Notifications.setNotificationChannelAsync(CHANNELS.urgent, {
    name: 'Urgent — child unaccounted for',
    description: 'Could not drop off, and no-shows after a check-in. Do not mute these.',
    importance: Notifications.AndroidImportance.MAX,
    sound: 'default',
    vibrationPattern: [0, 250, 250, 250],
    enableVibrate: true,
  });

  await Notifications.setNotificationChannelAsync(CHANNELS.arrivals, {
    name: 'Van is nearly here',
    description: 'The 15- and 5-minute warnings before your van is due.',
    importance: Notifications.AndroidImportance.HIGH,
    sound: 'default',
    enableVibrate: true,
  });

  await Notifications.setNotificationChannelAsync(CHANNELS.default, {
    name: 'Boarding and drop-off',
    description: 'Routine confirmations, delays and announcements.',
    importance: Notifications.AndroidImportance.DEFAULT,
    sound: 'default',
  });
}

/** Why push is not working, in words the person reading them can act on. */
export type PushState =
  | { ok: true; token: string }
  | { ok: false; reason: 'web' | 'simulator' | 'denied' | 'no-project-id' | 'failed'; message: string };

/**
 * The EAS project id the push service attributes tokens to.
 *
 * `getExpoPushTokenAsync` cannot mint a token without one. It defaults to
 * `expoConfig.extra.eas.projectId`, which is why that key now exists in
 * app.json — set it, or set EXPO_PUBLIC_EAS_PROJECT_ID, and push starts working.
 */
export function easProjectId(): string | undefined {
  return (
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID ||
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ||
    Constants.easConfig?.projectId ||
    undefined
  );
}

/**
 * Register this device for push and store the token on the user's profile,
 * where `send-push` looks for it.
 *
 * Safe to call on every launch — Expo returns the same token for the same
 * device and the write is idempotent.
 */
export async function registerForPush(userId: string): Promise<PushState> {
  if (!supported) {
    return {
      ok: false,
      reason: 'web',
      message:
        'This is the web app, which cannot receive push. Alerts still appear in the app while it is open.',
    };
  }

  if (!Device.isDevice) {
    return {
      ok: false,
      reason: 'simulator',
      message: 'Simulators cannot receive push notifications. Use a real phone.',
    };
  }

  await ensureChannels();

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    status = (
      await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      })
    ).status;
  }
  if (status !== 'granted') {
    return {
      ok: false,
      reason: 'denied',
      message:
        'Notifications are switched off for this app. Turn them on in your phone’s Settings, or you will only see alerts when the app is already open.',
    };
  }

  const projectId = easProjectId();
  if (!projectId) {
    return {
      ok: false,
      reason: 'no-project-id',
      message:
        'This build has no EAS project id, so the push service will not issue a token. Set `extra.eas.projectId` in app.json (or EXPO_PUBLIC_EAS_PROJECT_ID) and rebuild.',
    };
  }

  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    const { error } = await supabase
      .from('profiles')
      .update({ expo_push_token: token })
      .eq('id', userId);
    if (error) {
      return { ok: false, reason: 'failed', message: `Could not save the push token: ${error.message}` };
    }
    return { ok: true, token };
  } catch (e) {
    return {
      ok: false,
      reason: 'failed',
      message: `The push service refused to issue a token: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
}

/**
 * Shows a notification immediately, from the device itself.
 *
 * Used to prove the pipe works end to end without waiting for a van. This is a
 * LOCAL notification, so it tests permissions and channels but NOT the server
 * path — a device that shows this and still misses real alerts has a token,
 * webhook or Edge Function problem, not a phone problem.
 */
export async function notifyLocally(title: string, body: string) {
  if (!supported) return false;
  const { granted } = await Notifications.getPermissionsAsync();
  if (!granted) return false;
  await ensureChannels();
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      sound: 'default',
      ...(Platform.OS === 'android' ? { channelId: CHANNELS.default } : {}),
    },
    trigger: null,
  });
  return true;
}
