import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { PropsWithChildren } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Profile, Role } from './types';

/** What an invite code turns out to be for. Checked before the account exists. */
export interface InviteDetails {
  role: Role | null;
  full_name: string;
  email: string | null;
  valid: boolean;
  reason: string | null;
}

/**
 * Look up an invite code while signed out.
 *
 * The signup flow shows the person who they are and what role the office gave
 * them BEFORE they fill in a password, so a wrong code fails immediately rather
 * than after they have typed everything.
 */
export async function lookupInvite(code: string): Promise<InviteDetails> {
  const { data, error } = await supabase.rpc('invite_details', {
    invite_code: code.trim(),
  });
  if (error) throw new Error(error.message);

  const row = (data as InviteDetails[] | null)?.[0];
  return (
    row ?? {
      role: null,
      full_name: '',
      email: null,
      valid: false,
      reason: 'That invite code is not recognised.',
    }
  );
}

interface AuthValue {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  /** True only after the portal password has been entered this launch. */
  staffUnlocked: boolean;
  /** Signed in, but there is no profile behind the session. */
  profileMissing: boolean;
  isStaff: boolean;
  isAdmin: boolean;
  signIn(email: string, password: string): Promise<void>;
  signUp(input: {
    email: string;
    password: string;
    fullName: string;
    phone: string;
    inviteCode: string;
  }): Promise<void>;
  signOut(): Promise<void>;
  refreshProfile(): Promise<void>;
  unlockStaff(password: string): Promise<void>;
  lockStaff(): void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

/**
 * If an admin removed this account they left a message saying why. Surfaced at
 * sign-in, because the account no longer exists to receive an in-app one.
 */
export async function removalNoticeFor(email: string): Promise<string | null> {
  const { data } = await supabase.rpc('removal_notice_for', { target_email: email });
  return (data as string | null) ?? null;
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [staffUnlocked, setStaffUnlocked] = useState(false);
  /** Signed in, but the account behind the session no longer exists. */
  const [profileMissing, setProfileMissing] = useState(false);

  const loadProfile = useCallback(async (userId: string | undefined) => {
    if (!userId) {
      setProfile(null);
      setProfileMissing(false);
      return;
    }

    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    setProfile((data as Profile) ?? null);

    // A session whose profile cannot be loaded is a dead end: the app used to
    // sit on a spinner forever. It happens for real — the account was deleted,
    // or the schema was rebuilt underneath a stored session. Record it so the
    // UI can offer a way out instead of hanging.
    setProfileMissing(Boolean(!data || error));
  }, []);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      await loadProfile(data.session?.user.id);
      if (active) setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, next) => {
      setSession(next);
      setStaffUnlocked(false);
      await loadProfile(next?.user.id);
      setLoading(false);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  // A pending account is waiting on an admin. Poll while they wait so approval
  // moves them into the app without needing to force-quit and sign in again.
  useEffect(() => {
    if (profile?.status !== 'pending' || !session?.user.id) return;
    const timer = setInterval(() => loadProfile(session.user.id), 15_000);
    return () => clearInterval(timer);
  }, [profile?.status, session?.user.id, loadProfile]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw error;
  }, []);

  const signUp = useCallback<AuthValue['signUp']>(
    async ({ email, password, fullName, phone, inviteCode }) => {
      // Note what is NOT sent here: a role. The signup trigger reads it off the
      // invite row and ignores anything the client claims. Without a valid code
      // the trigger raises and no account is created at all.
      const { error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            invite_code: inviteCode.trim(),
            full_name: fullName.trim(),
            phone: phone.trim(),
          },
        },
      });
      if (error) throw error;
    },
    [],
  );

  const signOut = useCallback(async () => {
    setStaffUnlocked(false);
    await supabase.auth.signOut();
  }, []);

  const refreshProfile = useCallback(async () => {
    await loadProfile(session?.user.id);
  }, [loadProfile, session?.user.id]);

  const unlockStaff = useCallback(async (password: string) => {
    const { data, error } = await supabase.functions.invoke('admin-unlock', {
      body: { password },
    });
    if (error) {
      let message = 'Incorrect portal password.';
      const res = (error as { context?: Response }).context;
      if (res && typeof res.json === 'function') {
        const body = await res.json().catch(() => null);
        if (body?.error) message = body.error;
      }
      throw new Error(message);
    }
    if (!data?.ok) throw new Error('Incorrect portal password.');
    setStaffUnlocked(true);
  }, []);

  const isStaff = profile?.role === 'coordinator' || profile?.role === 'admin';

  const value = useMemo<AuthValue>(
    () => ({
      session,
      profile,
      loading,
      staffUnlocked,
      profileMissing,
      isStaff,
      isAdmin: profile?.role === 'admin',
      signIn,
      signUp,
      signOut,
      refreshProfile,
      unlockStaff,
      lockStaff: () => setStaffUnlocked(false),
    }),
    [
      session,
      profile,
      loading,
      staffUnlocked,
      profileMissing,
      isStaff,
      signIn,
      signUp,
      signOut,
      refreshProfile,
      unlockStaff,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
