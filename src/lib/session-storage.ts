/**
 * Where Supabase keeps the session. NATIVE version.
 *
 * React Native has no `localStorage`, so SDK 57's Supabase guide installs an
 * expo-sqlite-backed shim that provides one.
 *
 * There is a `.web.ts` sibling to this file, and that split is load-bearing.
 * Metro resolves `.web.ts` first when bundling for web, so `expo-sqlite` is
 * never even *referenced* in the web bundle.
 *
 * A runtime check does NOT work here:
 *
 *     if (Platform.OS !== 'web') require('expo-sqlite/localStorage/install');
 *
 * Metro resolves `require()` statically, at build time. It bundles expo-sqlite
 * for web anyway, pulls in the SQLite WASM worker, fails to resolve
 * `wa-sqlite.wasm`, and the web build dies — no matter what the runtime check
 * says. Platform-specific files are the only thing that actually keeps a native
 * module out of the web bundle.
 */
import 'expo-sqlite/localStorage/install';

export const sessionStorage = localStorage;
