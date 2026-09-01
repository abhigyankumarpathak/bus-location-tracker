import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFeatures } from '../../src/lib/org';
import { supabase } from '../../src/lib/supabase';
import { useMyChildren } from '../../src/lib/hooks';
import type { Attendance } from '../../src/lib/types';
import { Card, Empty, Loading, Row, Screen, Title, theme } from '../../src/components/ui';

/**
 * The register going back as far as it is kept.
 *
 * DELIBERATELY ONLY SHOWS WHAT WAS MARKED. A day with no row is not listed as
 * "absent", because the register does not record absence — it records scans.
 * Listing every calendar day with a red cross would invent a fact for every
 * evening a child simply did not ride, every weekend, and every holiday.
 *
 * It also stops where the purge does. Rows older than `retention_weeks` (three
 * by default) are deleted by the Sunday job to keep the table from growing
 * without bound, so the screen says so rather than letting a parent conclude
 * their child was never marked in April.
 */
export default function ParentAttendanceHistory() {
  const { children, loading: childrenLoading } = useMyChildren();
  const { retentionWeeks } = useFeatures();

  const [marks, setMarks] = useState<Attendance[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!children.length) {
      setMarks([]);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from('attendance')
      .select('*')
      .in('student_id', children.map((c) => c.id))
      .order('on_date', { ascending: false });
    setMarks((data as Attendance[]) ?? []);
    setLoading(false);
  }, [children]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (childrenLoading || loading) return <Loading />;

  const byDate = [...new Set(marks.map((m) => m.on_date))];

  return (
    <Screen>
      <Title sub="Evenings your child was marked attended.">History</Title>

      {byDate.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        byDate.map((date) => {
          const onThisDay = marks.filter((m) => m.on_date === date);
          return (
            <Card key={date}>
              <Text style={styles.date}>
                {new Date(`${date}T12:00:00`).toLocaleDateString([], {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                })}
              </Text>
              {onThisDay.map((m) => {
                const child = children.find((c) => c.id === m.student_id);
                return (
                  <Row key={m.id} style={styles.between}>
                    <Text style={styles.name}>{child?.full_name ?? 'Student'}</Text>
                    <Text style={styles.time}>
                      {new Date(m.marked_at).toLocaleTimeString([], {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                      {m.source === 'staff' ? ' · office' : ''}
                    </Text>
                  </Row>
                );
              })}
            </Card>
          );
        })
      )}

      <Card>
        <Text style={styles.fine}>
          Only evenings that were marked appear here — a day with no entry means nobody scanned,
          not that your child was recorded absent.
        </Text>
        <Text style={styles.fine}>
          The register is kept for {retentionWeeks} weeks and then cleared, so this list does not
          go back further than that.
        </Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  between: { justifyContent: 'space-between' },
  date: { fontSize: 15, fontWeight: '700', color: theme.accent },
  name: { fontSize: 15, color: theme.text, flexShrink: 1 },
  time: { fontSize: 13, color: theme.muted },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
});
