import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../src/lib/auth';
import { useFeatures } from '../../src/lib/org';
import { supabase } from '../../src/lib/supabase';
import { useNotifications, useReference } from '../../src/lib/hooks';
import type { Student } from '../../src/lib/types';
import { PaymentsLocked } from '../../src/components/Disabled';
import { FamilyLinks } from '../../src/components/FamilyLinks';
import {
  Badge,
  Button,
  Card,
  Empty,
  Row,
  Screen,
  SectionLabel,
  Title,
  theme,
} from '../../src/components/ui';

/**
 * Blueprint §4.1: the student's Profile is READ-ONLY in the MVP — name, school,
 * grade, linked guardians, default hubs. The student does not pick their own
 * hub or route; the transport office assigns them. That is why there is nothing
 * editable here, and it is deliberate rather than unfinished.
 */
export default function StudentProfile() {
  const { session, profile, signOut } = useAuth();
  const { paymentsEnabled } = useFeatures();
  const ref = useReference();
  const me = session?.user.id;

  const { items: notifications, unread, markAllRead } = useNotifications(me);
  const [student, setStudent] = useState<Student | null>(null);

  const load = useCallback(async () => {
    if (!me) return;

    const { data: s } = await supabase
      .from('students')
      .select('*')
      .eq('student_id', me)
      .maybeSingle();
    setStudent((s as Student) ?? null);
  }, [me]);

  // Tabs stay mounted, so a mount-only fetch never refreshes. Refetch on focus.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  return (
    <Screen>
      <Title sub={profile?.full_name || undefined}>Profile</Title>

      <Card>
        <Detail label="Name" value={profile?.full_name || '—'} />
        <Detail label="School" value={ref.schoolOf(student?.school_id)?.name ?? 'Not assigned'} />
        <Detail label="Grade" value={student?.grade ?? '—'} />
        <Detail
          label="Morning hub"
          value={ref.hubOf(student?.morning_hub_id)?.name ?? 'Not assigned'}
        />
        <Detail
          label="Afternoon hub"
          value={ref.hubOf(student?.afternoon_hub_id)?.name ?? 'Not assigned'}
        />
        <Text style={styles.fine}>
          The transport office sets your school, grade, and hubs. If any of this is wrong, ask them
          to change it.
        </Text>
      </Card>

      {/* A link is a request the other side accepts — and the student IS the
          other side. This section used to list accepted guardians only, so a
          parent's request landed in the database and the student was never
          shown it: nowhere to accept, nothing to decline, and the parent left
          watching a request that could never go through. */}
      <SectionLabel>Parents</SectionLabel>
      <FamilyLinks perspective="student" />

      <Row style={styles.between}>
        <SectionLabel>Notifications</SectionLabel>
        {unread > 0 ? (
          <Button label={`Mark read (${unread})`} variant="ghost" onPress={markAllRead} />
        ) : null}
      </Row>

      {notifications.length === 0 ? (
        <Empty>Nothing yet.</Empty>
      ) : (
        notifications.slice(0, 8).map((n) => (
          <Card key={n.id}>
            <Row style={styles.between}>
              <Text style={styles.name}>{n.title}</Text>
              {!n.read_at ? <Badge label="New" tone="accent" /> : null}
            </Row>
            <Text style={styles.fine}>{n.body}</Text>
          </Card>
        ))
      )}

      {!paymentsEnabled ? (
        <>
          <SectionLabel>Payments</SectionLabel>
          <PaymentsLocked />
        </>
      ) : null}

      <Button label="Sign out" variant="secondary" onPress={signOut} />
    </Screen>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  detail: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  detailLabel: { fontSize: 14, color: theme.muted },
  detailValue: {
    fontSize: 14,
    color: theme.text,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
  },
  name: { fontSize: 15, fontWeight: '700', color: theme.text },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  between: { justifyContent: 'space-between', alignItems: 'center' },
  grow: { flex: 1 },
});
