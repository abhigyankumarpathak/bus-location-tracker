import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { supabase } from './supabase';
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
  const { org } = useOrg();
  return {
    gpsEnabled: org?.gps_enabled ?? false,
    paymentsEnabled: org?.payments_enabled ?? false,
    // 'manual' is the only mode actually built; 'scan' is reserved for NFC/QR
    // self check-in later. Defaults to manual so nothing changes until it ships.
    attendanceMode: org?.attendance_mode ?? 'manual',
  };
}

export function OrgProvider({ children }: PropsWithChildren) {
  const [org, setOrg] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const { data } = await supabase.from('organization').select('*').eq('id', 1).maybeSingle();
    setOrg((data as Organization) ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <OrgContext.Provider value={{ org, loading, reload }}>{children}</OrgContext.Provider>
  );
}
