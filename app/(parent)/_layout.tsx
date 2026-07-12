import { Tabs } from 'expo-router';
import { TabIcon } from '../../src/components/TabIcon';
import { tabScreenOptions } from '../(student)/_layout';

export default function ParentLayout() {
  return (
    <Tabs screenOptions={tabScreenOptions}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Children',
          tabBarIcon: ({ focused }) => <TabIcon glyph="👧" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="change"
        options={{
          title: 'Daily change',
          tabBarIcon: ({ focused }) => <TabIcon glyph="✏️" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="alerts"
        options={{
          title: 'Alerts',
          tabBarIcon: ({ focused }) => <TabIcon glyph="🔔" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: ({ focused }) => <TabIcon glyph="⚙️" focused={focused} />,
        }}
      />
    </Tabs>
  );
}
