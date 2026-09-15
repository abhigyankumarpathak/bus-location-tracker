import { AppState, Platform } from 'react-native';
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
      // PKCE for everybody. The implicit flow puts the token in a URL fragment,
      // which ends up in browser history and in whatever the phone's OS logs
      // about opened links; PKCE puts a one-time CODE there instead and the
      // real token never travels in a URL. It is also the only flow that works
      // across the native browser round-trip in ./auth.
      flowType: 'pkce',
      // On WEB the provider sends the browser back to this site with ?code=,
      // and this is what notices it and exchanges it for a session. Native
      // never gets the session via a URL -- ./auth captures the redirect from
      // the in-app browser and exchanges the code by hand -- so it stays off
      // there, where it would only ever be looking at a deep link.
      detectSessionInUrl: Platform.OS === 'web',
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
