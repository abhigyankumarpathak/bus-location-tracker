import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { supabase } from '../../src/lib/supabase';
import { useReference } from '../../src/lib/hooks';
import {
  RIDER_STATUS_LABEL,
  RIDER_STATUS_TONE,
  ROUTE_TYPE_LABEL,
} from '../../src/lib/types';
import type { DailyTrip, StudentTripStatus } from '../../src/lib/types';
import { WeeklyReports } from '../../src/components/WeeklyReports';
import {
  Badge,
  Card,
  Empty,
  Loading,
  Row,
  Screen,
  SectionLabel,
  Title,
  theme,
} from '../../src/components/ui';

/** Blueprint §4.1: date, route type, boarded time, drop-off time, final status. */
export default function StudentHistory() {
  const ref = useReference();
  const [rows, setRows] = useState<StudentTripStatus[]>([]);
  const [trips, setTrips] = useState<DailyTrip[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    // RLS scopes this to the signed-in student's own rows.
    const { data: s } = await supabase
      .from('student_trip_status')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(60);

    const statuses = (s as StudentTripStatus[]) ?? [];
    setRows(statuses);

    if (statuses.length) {
      const { data: t } = await supabase
        .from('daily_trips')
        .select('*')
        .in('id', [...new Set(statuses.map((r) => r.trip_id))]);
      setTrips((t as DailyTrip[]) ?? []);
    }
    setLoading(false);
  }, []);

  // Tabs stay mounted, so a mount-only fetch never refreshes. Refetch on focus.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (loading || ref.loading) return <Loading />;

  return (
    <Screen>
      <Title sub="Your past trips and how each one ended.">History</Title>

      <WeeklyReports />

      <SectionLabel>Recent trips</SectionLabel>

      {rows.length === 0 ? <Empty>No trips recorded yet.</Empty> : null}

      {rows.map((row) => {
        const trip = trips.find((t) => t.id === row.trip_id);
        const route = ref.routeOf(trip?.route_id);

        return (
          <Card key={row.id}>
            <Row style={styles.between}>
              <View style={styles.grow}>
                <Text style={styles.date}>{trip?.date ?? '—'}</Text>
                <Text style={styles.fine}>
                  {route ? `${ROUTE_TYPE_LABEL[route.type]} · ${route.name}` : 'Trip'}
                </Text>
              </View>
              <Badge label={RIDER_STATUS_LABEL[row.status]} tone={RIDER_STATUS_TONE[row.status]} />
            </Row>

            <Row style={styles.times}>
              <Time label="Checked in" value={row.check_in_time} />
              <Time label="Boarded" value={row.board_time} />
              <Time label="Dropped off" value={row.dropoff_time} />
            </Row>

            {row.note ? <Text style={styles.fine}>{row.note}</Text> : null}
          </Card>
        );
      })}
    </Screen>
  );
}

function Time({ label, value }: { label: string; value: string | null }) {
  return (
    <View style={styles.time}>
      <Text style={styles.timeLabel}>{label}</Text>
      <Text style={[styles.timeValue, !value && styles.timeMissing]}>
        {value
          ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
          : '—'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  between: { justifyContent: 'space-between' },
  grow: { flex: 1 },
  date: { fontSize: 15, fontWeight: '700', color: theme.text },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  times: { gap: 0 },
  time: { flex: 1, gap: 2 },
  timeLabel: { fontSize: 11, color: theme.faint },
  timeValue: { fontSize: 14, color: theme.text, fontWeight: '600' },
  timeMissing: { color: theme.faint, fontWeight: '400' },
});
