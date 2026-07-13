import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../src/lib/auth';
import { useFeatures } from '../../src/lib/org';
import { supabase } from '../../src/lib/supabase';
import { useMyChildren, useReference } from '../../src/lib/hooks';
import {
  RIDER_STATUS_LABEL,
  RIDER_STATUS_TONE,
  ROUTE_TYPE_LABEL,
} from '../../src/lib/types';
import type { DailyTrip, StudentTripStatus } from '../../src/lib/types';
import { FamilyLinks } from '../../src/components/FamilyLinks';
import { WeeklyReports } from '../../src/components/WeeklyReports';
import { PaymentsLocked } from '../../src/components/Disabled';
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

export default function ParentMore() {
  const { profile, signOut } = useAuth();
  const { paymentsEnabled } = useFeatures();
  const { children } = useMyChildren();
  const ref = useReference();

  const [rows, setRows] = useState<StudentTripStatus[]>([]);
  const [trips, setTrips] = useState<DailyTrip[]>([]);

  const load = useCallback(async () => {
    const { data: s } = await supabase
      .from('student_trip_status')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(40);

    const statuses = (s as StudentTripStatus[]) ?? [];
    setRows(statuses);

    if (statuses.length) {
      const { data: t } = await supabase
        .from('daily_trips')
        .select('*')
        .in('id', [...new Set(statuses.map((r) => r.trip_id))]);
      setTrips((t as DailyTrip[]) ?? []);
    }
  }, []);

  // Tabs stay mounted, so a mount-only fetch never refreshes. Refetch on focus.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const nameFor = (id: string) => children.find((c) => c.id === id)?.full_name ?? 'Child';

  return (
    <Screen>
      <Title sub={profile?.full_name || undefined}>More</Title>

      <SectionLabel>Family</SectionLabel>
      <FamilyLinks perspective="parent" />

      {/* The permanent record. Recent trips (below) are cleared after a few
          weeks; these reports are not. */}
      <WeeklyReports studentNameFor={nameFor} />

      <SectionLabel>Recent trips</SectionLabel>
      {rows.length === 0 ? (
        <Empty>No trips recorded yet.</Empty>
      ) : (
        rows.slice(0, 15).map((row) => {
          const trip = trips.find((t) => t.id === row.trip_id);
          const route = ref.routeOf(trip?.route_id);
          return (
            <Card key={row.id}>
              <Row style={styles.between}>
                <View style={styles.grow}>
                  <Text style={styles.name}>
                    {nameFor(row.student_id)} · {trip?.date ?? '—'}
                  </Text>
                  <Text style={styles.fine}>
                    {route ? ROUTE_TYPE_LABEL[route.type] : 'Trip'}
                    {row.board_time
                      ? ` · boarded ${new Date(row.board_time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                      : ''}
                    {row.dropoff_time
                      ? ` · dropped ${new Date(row.dropoff_time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                      : ''}
                  </Text>
                </View>
                <Badge label={RIDER_STATUS_LABEL[row.status]} tone={RIDER_STATUS_TONE[row.status]} />
              </Row>
            </Card>
          );
        })
      )}

      <SectionLabel>Payments</SectionLabel>
      {paymentsEnabled ? (
        <Empty>Payments are enabled. Invoices appear here.</Empty>
      ) : (
        <PaymentsLocked />
      )}

      <Button label="Sign out" variant="secondary" onPress={signOut} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  between: { justifyContent: 'space-between' },
  grow: { flex: 1 },
  name: { fontSize: 15, fontWeight: '700', color: theme.text },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
});
