import { Redirect } from 'expo-router';
import { useAuth } from '../src/lib/auth';
import { useFeatures } from '../src/lib/org';
import { Loading } from '../src/components/ui';

export default function Index() {
  const { session, profile, loading, staffUnlocked, isStaff, profileMissing } = useAuth();
  const { attendanceOnly, featuresLoading } = useFeatures();

  if (loading) return <Loading />;
  if (!session) return <Redirect href="/sign-in" />;

  // Signed in, no profile behind it. Two ways to get here: a social sign-in
  // whose invite has not been claimed yet (the normal case now), or an account
  // whose profile was deleted underneath a stored session. The claim screen
  // handles the first and offers sign-out for the second -- before this it was
  // a spinner forever.
  if (!profile) return profileMissing ? <Redirect href="/claim" /> : <Loading />;

  // Pending and suspended both land here — neither can use the app.
  if (profile.status !== 'active') return <Redirect href="/pending" />;

  // WAIT for the real flags. Every branch below navigates, and a redirect fired
  // on a default is permanent: when the org row lands a moment later nothing
  // re-navigates, so the app sits on the wrong screen until it is reloaded.
  // That is the "it opens in the wrong mode and I have to refresh" bug.
  if (featuresLoading) return <Loading />;

  // In attendance-only mode the default screen for each role is the register.
  // The other screens still exist and still work — they are simply not where
  // anybody lands, and not reachable from the tab bar.
  switch (profile.role) {
    case 'student':
      return <Redirect href={attendanceOnly ? '/(student)/attendance' : '/(student)'} />;
    case 'parent':
      return <Redirect href={attendanceOnly ? '/(parent)/attendance' : '/(parent)'} />;
    case 'driver':
      return <Redirect href="/(driver)" />;
    case 'coordinator':
    case 'admin':
      if (!isStaff || !staffUnlocked) return <Redirect href="/unlock" />;
      return <Redirect href={attendanceOnly ? '/(staff)/attendance' : '/(staff)'} />;
  }
}
