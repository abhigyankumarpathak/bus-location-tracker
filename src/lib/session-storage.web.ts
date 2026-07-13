/**
 * Where Supabase keeps the session. WEB version.
 *
 * The browser already has a real `localStorage`, so there is nothing to install.
 * Metro picks this file over `session-storage.ts` when bundling for web, which
 * is what keeps `expo-sqlite` (and its SQLite WASM worker) out of the web bundle
 * entirely. See the note in the native sibling — the split is not cosmetic.
 */
export const sessionStorage = globalThis.localStorage;
