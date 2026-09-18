import { Platform } from 'react-native';

/**
 * Where this app lives, for a message somebody pastes into a text.
 *
 * NOT hardcoded. The Render subdomain is a placeholder that stops being right
 * the day a real domain is bought, and a stale link in an invite is worse than
 * no link: the person taps it, lands nowhere, and assumes the code is bad.
 *
 * On web the running page already knows its own origin, which cannot go stale.
 * Everywhere else it comes from EXPO_PUBLIC_APP_URL, set alongside the Supabase
 * credentials — it is compiled into the bundle at build time like they are.
 */
const configured = process.env.EXPO_PUBLIC_APP_URL?.trim().replace(/\/+$/, '');

export function appUrl(): string | null {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return configured || null;
}
