import { AppState, Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';

/**
 * Session storage differs by platform.
 *
 * On native there is no `localStorage`, so SDK 57's Supabase guide installs an
 * expo-sqlite-backed shim. On web the browser already has a real one, and
 * importing the shim there would pull SQLite (and a wasm blob) into the bundle
 * for no reason. `require` rather than a top-level import, because the import
 * has to be conditional.
 */
if (Platform.OS !== 'web') {
  require('expo-sqlite/localStorage/install');
}

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
      storage: localStorage,
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
