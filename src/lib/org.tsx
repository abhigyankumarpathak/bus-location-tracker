import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { supabase } from './supabase';
import { useAuth } from './auth';
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
  // Read from the auth context rather than subscribing here. OrgProvider is
  // mounted inside AuthProvider, and a second onAuthStateChange subscription
  // that awaited a query inside its callback would deadlock the same way the
  // first one did — see the note on that subscription. This gets the same
  // signal with none of the risk.
  const { session, profile, loading: authLoading } = useAuth();

  const [org, setOrg] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const { data } = await supabase.from('organization').select('*').eq('id', 1).maybeSingle();
    setOrg((data as Organization) ?? null);
  }, []);

  /**
   * Re-read whenever who is signed in changes.
   *
   * `read org` is `using (is_active())`, so this returns NOTHING to a caller
   * without a session — and on a fresh browser the session is still being
   * restored when the provider mounts. An empty org row reads as every feature
   * switched OFF, which is what put a new browser into the full app while the
   * operation was in attendance-only mode.
   *
   * `loading` settles only once auth has an answer, because screens that
   * NAVIGATE on a flag wait for it, and a redirect fired on a default is
   * permanent — nothing re-navigates when the real value lands.
   */
  useEffect(() => {
    if (authLoading) return;

    let alive = true;

    // Back to true on every re-read, because what is in `org` right now is the
    // PREVIOUS answer and screens navigate on these flags. Redirecting on a
    // stale value is permanent — nothing re-navigates when the real one lands.
    setLoading(true);

    (async () => {
      await reload();
      if (alive) setLoading(false);
    })();

    return () => {
      alive = false;
    };
    // PROFILE, not just the session. `read org` is `using (is_active())`, which
    // reads the profiles table — so a signed-in user with no profile yet is
    // refused, and `org` comes back null, which reads as every feature OFF.
    //
    // That is exactly the state a Google signup is in at the moment it returns:
    // session established, profile not created until the invite is claimed a
    // second later. Keying only on the session meant the org was never re-read
    // once the profile appeared, so the student landed on the full-platform
    // screens and a manual refresh was the only way out.
  }, [authLoading, session?.user.id, profile?.id, profile?.status, reload]);

  return (
    <OrgContext.Provider value={{ org, loading, reload }}>{children}</OrgContext.Provider>
  );
}

