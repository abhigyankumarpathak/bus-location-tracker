import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * "The van is 15 minutes away" / "5 minutes away".
 *
 * The blueprint's version of this is GPS-derived ("Approaching stop", §6.2) and
 * therefore impossible while tracking is switched off. But a family does not
 * actually need GPS to be told to start walking to the hub — they need to know
 * the van is nearly due. The PLANNED arrival time is enough for that, and it is
 * data the transport office already has.
 *
 * So these alerts fire off the schedule, not off a vehicle's position:
 *
 *   planned arrival 07:18  ->  notify at 07:03 and at 07:13
 *
 * Honest about what it is: this says "your van is DUE in 15 minutes", not "your
 * van IS 15 minutes away". If the van is running late, the alert still fires on
 * time — the driver's delay report is what tells you otherwise. When GPS is
 * switched on, these become real proximity alerts and the wording changes.
 *
 * Local notifications, so they work with no server and no push credentials. The
 * cost is that they only fire if the app has been opened at some point that day
 * to schedule them, which for a daily-use app is a reasonable trade.
 */

/** Blueprint §4.1: "Alerts when the van is 15 and 5 minutes away." */
export const ALERT_MINUTES = [15, 5] as const;

const supported = Platform.OS !== 'web';

export interface HubArrival {
  /** Stable key so re-scheduling replaces rather than duplicates. */
  id: string;
  /** "Corner of Oak Road and Example Way" */
  hubName: string;
  /** 'HH:MM' or 'HH:MM:SS' — the stop's planned_arrival. */
  plannedArrival: string;
  /** Shown to a parent, who needs to know WHICH child. Omit for the student. */
  studentName?: string;
}

/**
 * Replace today's alerts with a fresh set.
 *
 * Cancels everything previously scheduled first, so opening the app twice does
 * not produce two notifications, and a changed hub or time does not leave the
 * old alert behind.
 */
export async function scheduleArrivalAlerts(arrivals: HubArrival[]) {
  if (!supported) return;

  const { granted } = await Notifications.getPermissionsAsync();
  if (!granted) return;

  await Notifications.cancelAllScheduledNotificationsAsync();

  const now = new Date();

  for (const arrival of arrivals) {
    const due = timeToday(arrival.plannedArrival);
    if (!due) continue;

    for (const minutes of ALERT_MINUTES) {
      const fireAt = new Date(due.getTime() - minutes * 60_000);

      // A time that has already passed cannot be scheduled, and firing it
      // immediately would be worse than useless — "15 minutes away" arriving an
      // hour after the van left is actively misleading.
      if (fireAt <= now) continue;

      const who = arrival.studentName ? `${arrival.studentName}'s van` : 'Your van';

      await Notifications.scheduleNotificationAsync({
        content: {
          title: `${who} is due in ${minutes} minutes`,
          body: `Expected at ${arrival.hubName} at ${arrival.plannedArrival.slice(0, 5)}.`,
          data: { kind: 'arrival', hub: arrival.hubName, minutes },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: fireAt,
        },
      });
    }
  }
}

/** How many alerts are currently queued — used to show the user it is armed. */
export async function scheduledAlertCount(): Promise<number> {
  if (!supported) return 0;
  const all = await Notifications.getAllScheduledNotificationsAsync();
  return all.length;
}

/** 'HH:MM[:SS]' -> a Date today. Returns null if the string is not a time. */
function timeToday(hhmm: string): Date | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!match) return null;

  const d = new Date();
  d.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return d;
}
