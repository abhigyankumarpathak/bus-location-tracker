import { Tabs } from 'expo-router';
import { TabIcon } from '../../src/components/TabIcon';
import { useFeatures } from '../../src/lib/org';
import { theme } from '../../src/components/ui';

export const tabScreenOptions = {
  headerStyle: { backgroundColor: theme.bg },
  headerTintColor: theme.text,
  headerShadowVisible: false,
  tabBarStyle: { backgroundColor: theme.surface, borderTopColor: theme.border },
  tabBarActiveTintColor: theme.accent,
  tabBarInactiveTintColor: theme.faint,
  sceneStyle: { backgroundColor: theme.bg },
};

/**
 * `href: null` HIDES a tab without unregistering the screen, which is the
 * behaviour attendance-only mode needs: the route still exists, so nothing
 * breaks and no state is lost, it simply is not reachable. Flip the toggle back
 * and every tab returns exactly as it was.
 */
export const hidden = { href: null as null } as const;

export default function StudentLayout() {
  const { attendanceOnly } = useFeatures();

  return (
    <Tabs screenOptions={tabScreenOptions}>
      <Tabs.Screen
        name="attendance"
        options={
          attendanceOnly
            ? {
                title: 'Attendance',
                tabBarIcon: ({ focused }) => <TabIcon glyph="✅" focused={focused} />,
              }
            : hidden
        }
      />
      <Tabs.Screen
        name="index"
        options={
          attendanceOnly
            ? hidden
            : {
                title: 'Today',
                tabBarIcon: ({ focused }) => <TabIcon glyph="🚌" focused={focused} />,
              }
        }
      />
      <Tabs.Screen
        name="club"
        options={
          attendanceOnly
            ? hidden
            : {
                title: 'Club',
                tabBarIcon: ({ focused }) => <TabIcon glyph="🎨" focused={focused} />,
              }
        }
      />
      <Tabs.Screen
        name="history"
        options={
          attendanceOnly
            ? hidden
            : {
                title: 'History',
                tabBarIcon: ({ focused }) => <TabIcon glyph="🕘" focused={focused} />,
              }
        }
      />
      <Tabs.Screen
        name="profile"
        options={
          attendanceOnly
            ? hidden
            : {
                title: 'Profile',
                tabBarIcon: ({ focused }) => <TabIcon glyph="🎒" focused={focused} />,
              }
        }
      />
    </Tabs>
  );
}
