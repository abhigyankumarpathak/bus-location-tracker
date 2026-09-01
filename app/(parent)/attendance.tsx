import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFeatures, useToday } from '../../src/lib/org';
import { supabase } from '../../src/lib/supabase';
import { useMyChildren } from '../../src/lib/hooks';
import type { Attendance } from '../../src/lib/types';
import {
  Badge,
  Card,
  Empty,
  Loading,
  Row,
  Screen,
  Title,
  theme,
} from '../../src/components/ui';

/**
 * What a parent sees in attendance-only mode: did my child board this evening?
 *
 * Today only. The history is its own tab, because a parent opening this at six
 * o'clock wants one word, and a list of the last three weeks buries it.
 *
 * THE WORDING IS THE FEATURE. A missing row is the absence of a scan, not a
 * statement that the child was away — so it reads "Not marked", never "Absent".
 * The app genuinely does not know which, and saying so is the only honest
 * option: nobody confirmed anything, there is no driver in this mode to do it.
 */
export default function ParentAttendance() {
  const { children, loading: childrenLoading } = useMyChildren();
  const { attendanceOpensAt } = useFeatures();
  const today = useToday();

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
      .eq('on_date', today)
      .in('student_id', children.map((c) => c.id));
    setMarks((data as Attendance[]) ?? []);
    setLoading(false);
  }, [children, today]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (childrenLoading || loading) return <Loading />;

  if (!children.length) {
    return (
      <Screen>
        <Title sub="Link a child and their attendance appears here.">Attendance</Title>
        <Empty>No children linked to this account yet.</Empty>
      </Screen>
    );
  }

  return (
    <Screen>
      <Title sub={new Date(`${today}T12:00:00`).toLocaleDateString([], {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      })}>
        Attendance
      </Title>

      {children.map((child) => {
        const mark = marks.find((m) => m.student_id === child.id) ?? null;

        return (
          <Card key={child.id} style={mark ? styles.present : styles.absent}>
            <Row style={styles.between}>
              <Text style={styles.name}>{child.full_name}</Text>
              <Badge
                label={mark ? 'Boarded' : 'Not marked'}
                tone={mark ? 'success' : 'neutral'}
              />
            </Row>

            {mark ? (
              <Text style={styles.body}>
                Boarded in the evening, recorded at{' '}
                {new Date(mark.marked_at).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
                {mark.source === 'staff' ? ' by the office' : ''}.
              </Text>
            ) : (
              <>
                <Text style={styles.body}>Not boarded this evening.</Text>
                <Text style={styles.fine}>
                  Attendance opens at{' '}
                  {(() => {
                    const [h, m] = attendanceOpensAt.split(':').map(Number);
                    const at = new Date();
                    at.setHours(h || 0, m || 0, 0, 0);
                    return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                  })()}
                  . Nothing has been recorded — which means nobody scanned, not that anyone has
                  said your child is away.
                </Text>
              </>
            )}
          </Card>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  between: { justifyContent: 'space-between' },
  present: { borderColor: theme.success, gap: 8 },
  absent: { gap: 8 },
  name: { fontSize: 18, fontWeight: '700', color: theme.text, flexShrink: 1 },
  body: { fontSize: 15, color: theme.text, lineHeight: 21 },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
});
