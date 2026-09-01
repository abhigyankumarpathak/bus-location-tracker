import { Tabs } from 'expo-router';
import { TabIcon } from '../../src/components/TabIcon';
import { useFeatures } from '../../src/lib/org';
import { hidden, tabScreenOptions } from '../(student)/_layout';

export default function ParentLayout() {
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
        name="attendance-history"
        options={
          attendanceOnly
            ? {
                title: 'History',
                tabBarIcon: ({ focused }) => <TabIcon glyph="🕘" focused={focused} />,
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
                title: 'Children',
                tabBarIcon: ({ focused }) => <TabIcon glyph="👧" focused={focused} />,
              }
        }
      />
      <Tabs.Screen
        name="map"
        options={
          attendanceOnly
            ? hidden
            : {
                title: 'Map',
                tabBarIcon: ({ focused }) => <TabIcon glyph="🗺️" focused={focused} />,
              }
        }
      />
      <Tabs.Screen
        name="change"
        options={
          attendanceOnly
            ? hidden
            : {
                title: 'Report',
                tabBarIcon: ({ focused }) => <TabIcon glyph="✏️" focused={focused} />,
              }
        }
      />
      <Tabs.Screen
        name="alerts"
        options={
          attendanceOnly
            ? hidden
            : {
                title: 'Alerts',
                tabBarIcon: ({ focused }) => <TabIcon glyph="🔔" focused={focused} />,
              }
        }
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
