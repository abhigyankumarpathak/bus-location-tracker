/**
 * Runs before the dev server on Replit.
 *
 * The app already handles missing Supabase credentials gracefully — it boots to
 * a "Connect Supabase" screen instead of crashing. But a collaborator who has
 * just forked this has no reason to know *where* to put them, and Replit's
 * Secrets tab is not obvious. So say it in the console, where they are looking,
 * before the bundler's output buries it.
 *
 * This never blocks the run. A wrong-looking URL is a warning, not a gate.
 */

import { readFileSync } from 'node:fs';

/**
 * Expo reads .env; Node does not. On Replit there is no .env (secrets arrive as
 * real environment variables), but someone running this locally would otherwise
 * be told to go set secrets they have already set. So read both.
 */
function fromEnvFile(name) {
  try {
    const line = readFileSync('.env', 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith(`${name}=`));
    return line?.slice(line.indexOf('=') + 1).trim() || undefined;
  } catch {
    return undefined; // no .env — the normal case on Replit
  }
}

const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? fromEnvFile('EXPO_PUBLIC_SUPABASE_URL');
const key =
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  fromEnvFile('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');

const line = '─'.repeat(64);
const say = (...parts) => console.log(...parts);

if (!url || !key) {
  say(`\n${line}`);
  say('  This app needs a Supabase project before it can do anything.');
  say('');
  say('  Open the Secrets tab (🔒 in the left sidebar) and add:');
  say('');
  say('    EXPO_PUBLIC_SUPABASE_URL              https://<ref>.supabase.co');
  say('    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY  sb_publishable_...');
  say('');
  say('  Both are in the Supabase dashboard:');
  say('    Project Settings → Data API   (the URL)');
  say('    Project Settings → API Keys   (the publishable key)');
  say('');
  say('  Then press Run again. Setup guide: supabase/SETUP.md');
  say(`${line}\n`);
  say('  Starting anyway — you will see a "Connect Supabase" screen.\n');
} else {
  // Pasting the service_role key here would hand every visitor a key that
  // bypasses every RLS policy. That is not a warning; that is a stop.
  if (/^sb_secret_|service_role/.test(key)) {
    say('\n  ⛔  That looks like a SECRET / service_role key. Do not use it here.');
    say('      It bypasses every Row Level Security policy, and anything in');
    say('      EXPO_PUBLIC_* is compiled into the page every visitor downloads.');
    say('      Use the PUBLISHABLE (anon) key — that one is safe to ship,');
    say('      because RLS is what does the protecting.\n');
    process.exit(1);
  }

  // The URL mistake is easy to make and produces a baffling error at runtime
  // ("invalid path specified in url"), so name it here instead.
  const bare = url.replace(/\/+$/, '');
  if (/\/rest\/v1/.test(url) || bare !== url) {
    say('\n  ⚠  EXPO_PUBLIC_SUPABASE_URL should be the bare project URL —');
    say('     https://<ref>.supabase.co, with no /rest/v1 and no trailing slash.');
    say('     The client appends the path itself, so this will fail at runtime.\n');
  } else {
    say(`\n  ✓ Supabase configured — ${url}\n`);
  }
}
