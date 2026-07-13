import { AppState } from 'react-native';
import { createClient } from '@supabase/supabase-js';
// Resolves to session-storage.web.ts on web and session-storage.ts on native.
// That split is what keeps expo-sqlite out of the web bundle — see the comment
// in either file; a runtime Platform check does not work.
import { sessionStorage } from './session-storage';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/**
 * Whether the app has been pointed at a Supabase project yet.
 *
 * A missing .env is the normal state of a fresh clone, not a bug, so it must not
 * be a crash. The root layout checks this and shows setup instructions.
 */
export const isConfigured = Boolean(url && key);

export const supabase = createClient(
  url || 'https://placeholder.supabase.co',
  key || 'placeholder-key',
  {
    auth: {
      storage: sessionStorage,
      autoRefreshToken: isConfigured,
      persistSession: isConfigured,
      // Native never carries the session in a URL fragment. On web we are not
      // using OAuth redirects either, so this stays off in both.
      detectSessionInUrl: false,
    },
  },
);

// Supabase only refreshes tokens while the app is in the foreground; without
// this a session can expire while backgrounded and the next query 401s.
if (isConfigured) {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}
