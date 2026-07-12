import { Tabs } from 'expo-router';
import { TabIcon } from '../../src/components/TabIcon';
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

export default function StudentLayout() {
  return (
    <Tabs screenOptions={tabScreenOptions}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Today',
          tabBarIcon: ({ focused }) => <TabIcon glyph="🚌" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="club"
        options={{
          title: 'Club',
          tabBarIcon: ({ focused }) => <TabIcon glyph="🎨" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'History',
          tabBarIcon: ({ focused }) => <TabIcon glyph="🕘" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ focused }) => <TabIcon glyph="🎒" focused={focused} />,
        }}
      />
    </Tabs>
  );
}
