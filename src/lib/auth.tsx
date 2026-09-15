import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { PropsWithChildren } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
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

export type SocialProvider = 'google' | 'apple';

/**
 * Where the provider sends the browser back to.
 *
 * On web that is this site, and supabase-js notices the ?code= in the URL
 * itself (detectSessionInUrl). On native it is the app's own scheme, which the
 * in-app browser hands back to us as a string -- no page ever loads at it -- and
 * we exchange the code by hand below. Both must be listed under Supabase ->
 * Auth -> URL Configuration -> Redirect URLs, or the provider is told to send
 * the user somewhere Supabase refuses to honour.
 */
const redirectTo = () =>
  Platform.OS === 'web' && typeof window !== 'undefined'
    ? `${window.location.origin}/`
    : Linking.createURL('/auth');

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
  /**
   * Sign in through a provider. Creates the auth user on first use; the PROFILE
   * still has to be claimed with an invite code afterwards — see claimInvite.
   */
  signInWith(provider: SocialProvider): Promise<void>;
  /** Second step for a social sign-in: turn the invite into a profile and role. */
  claimInvite(code: string): Promise<void>;
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

  /**
   * Social sign-in, on both platforms.
   *
   * WEB is the easy half: supabase-js redirects the whole page to the provider,
   * the provider sends it back here with ?code=, and detectSessionInUrl
   * exchanges it. Nothing below the first call runs, because the page is gone.
   *
   * NATIVE cannot redirect a page it does not have. So the URL is fetched but
   * not followed (skipBrowserRedirect), opened in the system's auth browser --
   * which shares the user's existing Google session, so they usually just tap
   * their name -- and the redirect back to bustracker://auth is captured as a
   * string. The ?code= in it is exchanged by hand. PKCE makes that safe: the
   * code is single-use and bound to a verifier only this install holds.
   */
  const signInWith = useCallback<AuthValue['signInWith']>(async (provider) => {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: redirectTo(),
        skipBrowserRedirect: Platform.OS !== 'web',
      },
    });
    if (error) throw error;
    if (Platform.OS === 'web') return; // the page is navigating away

    if (!data.url) throw new Error('The sign-in page could not be opened.');

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo());
    if (result.type !== 'success') {
      // Cancelled or dismissed. Not an error worth a red banner; the person
      // simply closed it.
      return;
    }

    const code = new URL(result.url).searchParams.get('code');
    if (!code) throw new Error('The provider did not return a sign-in code.');

    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
    if (exchangeError) throw exchangeError;
  }, []);

  /**
   * The second step of a social sign-in.
   *
   * The account exists in Supabase Auth but has no profile, so it has no role
   * and RLS lets it read nothing. claim_invite() checks the code exactly as a
   * password signup would have -- same function, same rules -- and creates the
   * profile with the role the invite carries. Nobody picks their own role.
   */
  const claimInvite = useCallback<AuthValue['claimInvite']>(
    async (code) => {
      const { data, error } = await supabase.rpc('claim_invite', { code: code.trim() });
      if (error) throw error;
      const res = data as { ok: boolean; message?: string };
      if (!res?.ok) throw new Error(res?.message ?? 'That code did not work.');
      await loadProfile(session?.user.id);
    },
    [loadProfile, session?.user.id],
  );

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
      signInWith,
      claimInvite,
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
      signInWith,
      claimInvite,
      signUp,
      signOut,
      refreshProfile,
      unlockStaff,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
