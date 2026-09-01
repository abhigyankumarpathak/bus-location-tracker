import { Tabs } from 'expo-router';
import { TabIcon } from '../../src/components/TabIcon';
import { useFeatures } from '../../src/lib/org';
import { hidden, tabScreenOptions } from '../(student)/_layout';

/**
 * The transport office. Coordinators run the day; admins also configure.
 * Both roles share these tabs — the Setup tab hides admin-only controls from a
 * coordinator, and RLS refuses them regardless of what the UI shows.
 */
export default function StaffLayout() {
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
                title: 'Dashboard',
                tabBarIcon: ({ focused }) => <TabIcon glyph="📋" focused={focused} />,
              }
        }
      />
      {/* Exceptions first: it is the tab that means something is wrong right
          now. Notifications is the stream, and a stream can wait. */}
      <Tabs.Screen
        name="exceptions"
        options={
          attendanceOnly
            ? hidden
            : {
                title: 'Exceptions',
                tabBarIcon: ({ focused }) => <TabIcon glyph="⚠️" focused={focused} />,
              }
        }
      />
      <Tabs.Screen
        name="notifications"
        options={
          attendanceOnly
            ? hidden
            : {
                title: 'Notifications',
                tabBarIcon: ({ focused }) => <TabIcon glyph="🔔" focused={focused} />,
              }
        }
      />
      {/* People stays in BOTH modes. An attendance-only office still has to
          invite students and link guardians, and there is nowhere else to do
          it. */}
      <Tabs.Screen
        name="people"
        options={{
          title: 'People',
          tabBarIcon: ({ focused }) => <TabIcon glyph="👥" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="audit"
        options={
          attendanceOnly
            ? hidden
            : {
                title: 'History',
                tabBarIcon: ({ focused }) => <TabIcon glyph="🧾" focused={focused} />,
              }
        }
      />
      {/*
        Setup is NEVER hidden, in either mode. It is the only screen carrying the
        toggle, so hiding it would strand an admin in attendance-only mode with
        no way back short of a SQL console.
      */}
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
