import { Redirect } from 'expo-router';
import { useAuth } from '../src/lib/auth';
import { Loading } from '../src/components/ui';

export default function Index() {
  const { session, profile, loading, staffUnlocked, isStaff } = useAuth();

  if (loading || (session && !profile)) return <Loading />;
  if (!session || !profile) return <Redirect href="/sign-in" />;

  // Pending and suspended both land here — neither can use the app.
  if (profile.status !== 'active') return <Redirect href="/pending" />;

  switch (profile.role) {
    case 'student':
      return <Redirect href="/(student)" />;
    case 'parent':
      return <Redirect href="/(parent)" />;
    case 'driver':
      return <Redirect href="/(driver)" />;
    case 'coordinator':
    case 'admin':
      return isStaff && staffUnlocked ? <Redirect href="/(staff)" /> : <Redirect href="/unlock" />;
  }
}
