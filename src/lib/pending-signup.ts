import { sessionStorage } from './session-storage';

/**
 * What somebody typed before they were sent off to Google.
 *
 * Sign-up is code first, then details, then a choice: set a password, or finish
 * with Google. Choosing Google navigates the whole page away on web, so React
 * state — the invite code they entered, the name they typed — is gone by the
 * time they come back holding a session and no profile.
 *
 * This survives that, in the same store the Supabase session already uses (real
 * localStorage on web, an expo-sqlite shim on native). app/claim.tsx reads it on
 * the way back and applies it without asking them to type anything twice.
 *
 * It is NOT a credential and carries no authority. The invite code in here still
 * has to survive every check in validate_invite(), and the role still comes from
 * the invite row rather than anything stored on the device.
 */

const KEY = 'pending-signup';

export interface PendingSignup {
  code: string;
  fullName: string;
  phone: string;
  /** Stale entries are dropped rather than applied to some later sign-in. */
  at: number;
}

/** Long enough for a slow OAuth round trip, short enough not to haunt anyone. */
const MAX_AGE_MS = 30 * 60 * 1000;

export function stashSignup(input: Omit<PendingSignup, 'at'>) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...input, at: Date.now() }));
  } catch {
    // Private mode, or storage disabled. The claim screen simply asks for the
    // code, which is the behaviour this exists to avoid rather than to require.
  }
}

export function readSignup(): PendingSignup | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingSignup;
    if (!parsed?.code || Date.now() - parsed.at > MAX_AGE_MS) {
      clearSignup();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearSignup() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to do, and nothing depends on it having worked.
  }
}
