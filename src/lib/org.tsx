import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { supabase } from './supabase';
import { todayIn } from './day';
import type { Organization } from './types';

/**
 * Organisation settings and feature flags.
 *
 * Two features in this app are fully built but switched OFF, because the MVP
 * blueprint excludes them from the first release (live GPS and payments). The
 * flags live in the database rather than in the bundle so they can be turned on
 * for a demo without shipping a new build.
 */

const OrgContext = createContext<{
  org: Organization | null;
  loading: boolean;
  reload(): Promise<void>;
} | null>(null);

export function useOrg() {
  const value = useContext(OrgContext);
  if (!value) throw new Error('useOrg must be used inside <OrgProvider>');
  return value;
}

/** Convenience: the two blueprint-gated features, plus the attendance mode. */
export function useFeatures() {
  const { org, loading } = useOrg();
  return {
    /**
     * The org row has not arrived yet, so every flag below is a DEFAULT rather
     * than an answer. Anything that NAVIGATES on a flag must wait for this;
     * a redirect fired on a default is permanent, because nothing re-navigates
     * when the real value lands. See app/index.tsx.
     */
    featuresLoading: loading,
    gpsEnabled: org?.gps_enabled ?? false,
    paymentsEnabled: org?.payments_enabled ?? false,
    // 'manual' is the only mode actually built; 'scan' is reserved for NFC/QR
    // self check-in later. Defaults to manual so nothing changes until it ships.
    attendanceMode: org?.attendance_mode ?? 'manual',
    /**
     * How long a driver has to take back a mistap. The screen uses this to
     * decide whether to OFFER undo; the database enforces the real window
     * against the audit log, so a stale client cannot talk its way past it.
     */
    undoWindowSec: org?.undo_window_sec ?? 90,

    /**
     * ATTENDANCE-ONLY MODE. Every screen that shows a route, a trip, a vehicle
     * or a check-in reads this and renders the register instead.
     *
     * Defaults to FALSE before the org row arrives. That is the safe way round
     * for RENDERING — defaulting to true would blank a driver's roster mid-route
     * on a slow connection — but it is NOT safe for navigation, which is why
     * `featuresLoading` exists. Redirecting on this default is what made the app
     * open on the wrong screen until it was refreshed.
     */
    attendanceOnly: org?.attendance_only ?? false,
    /** "This is only for evenings." Wall clock in the operation's timezone. */
    attendanceOpensAt: org?.attendance_opens_at ?? '12:00',
    /** How long the register is kept before the Sunday purge clears it. */
    retentionWeeks: org?.retention_weeks ?? 3,
  };
}

/**
 * Today, where the vans are — the client's half of today_local() in schema.sql.
 *
 * Both read `organization.time_zone`, so the day a screen asks for and the day
 * the database generates trips against are the same day. Before this they were
 * both UTC, which meant that from 8pm in New York every screen went looking for
 * tomorrow and found nothing there.
 *
 * Reactive: the organisation row arrives a moment after mount, so this returns
 * the device's date for a render or two and then settles. Anything keyed on it
 * re-runs when it does.
 */
export function useToday() {
  const { org } = useOrg();
  return todayIn(org?.time_zone);
}

export function OrgProvider({ children }: PropsWithChildren) {
  const [org, setOrg] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * Read the row, and be honest about whether the answer can be trusted.
   *
   * `read org` is `using (is_active())`, so this query returns NOTHING to a
   * caller without a session. On a fresh browser the session is still being
   * restored from storage when the provider mounts, so the first read comes
   * back empty — and an empty org row reads as every feature switched OFF.
   *
   * That is what put a new browser into the full app when the operation was in
   * attendance-only mode, and why reloading fixed it: the second mount happened
   * with a session in hand.
   *
   * So `loading` stays true until the answer is worth acting on: either the row
   * arrived, or there is definitively nobody signed in to read it. Screens that
   * NAVIGATE on a flag wait for that — see app/index.tsx.
   */
  const reload = useCallback(async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const { data } = await supabase.from('organization').select('*').eq('id', 1).maybeSingle();
    setOrg((data as Organization) ?? null);

    if (data || !session) setLoading(false);
  }, []);

  useEffect(() => {
    let alive = true;
    const run = () => {
      if (alive) reload();
    };

    run();

    // AND AGAIN WHENEVER THE SESSION CHANGES. This is the actual fix: signing
    // in, restoring a session from storage, and refreshing a token all fire
    // here, so the flags are re-read the moment they become readable instead of
    // staying wrong until somebody reloads the page.
    const { data: sub } = supabase.auth.onAuthStateChange(run);

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [reload]);

  return (
    <OrgContext.Provider value={{ org, loading, reload }}>{children}</OrgContext.Provider>
  );
}
