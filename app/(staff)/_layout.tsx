import { Tabs } from 'expo-router';
import { TabIcon } from '../../src/components/TabIcon';
import { tabScreenOptions } from '../(student)/_layout';

/**
 * The transport office. Coordinators run the day; admins also configure.
 * Both roles share these tabs — the Setup tab hides admin-only controls from a
 * coordinator, and RLS refuses them regardless of what the UI shows.
 */
export default function StaffLayout() {
  return (
    <Tabs screenOptions={tabScreenOptions}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ focused }) => <TabIcon glyph="📋" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="exceptions"
        options={{
          title: 'Exceptions',
          tabBarIcon: ({ focused }) => <TabIcon glyph="⚠️" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="people"
        options={{
          title: 'People',
          tabBarIcon: ({ focused }) => <TabIcon glyph="👥" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="setup"
        options={{
          title: 'Setup',
          tabBarIcon: ({ focused }) => <TabIcon glyph="⚙️" focused={focused} />,
        }}
      />
    </Tabs>
  );
}
