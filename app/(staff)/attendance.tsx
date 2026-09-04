import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { alert } from '../../src/lib/alert';
import { useAuth } from '../../src/lib/auth';
import { useToday } from '../../src/lib/org';
import { supabase } from '../../src/lib/supabase';
import { ABSENCE_LABEL, registerCounts } from '../../src/lib/types';
import type { RegisterRow } from '../../src/lib/types';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorText,
  Loading,
  Row,
  Screen,
  SectionLabel,
  Title,
  theme,
} from '../../src/components/ui';

/**
 * The register, for the office.
 *
 * NOT MARKED SORTS FIRST, and that ordering is the whole point of the screen.
 * The useful question at the end of an evening is never "who is here" — it is
 * "who is not", and burying that under an alphabetical list of the ninety
 * students who scanned is how it gets missed.
 *
 * The manual mark exists because a flat battery otherwise produces an absent
 * record for a student standing in front of you. It is recorded as `staff`
 * rather than `scan`, so the two are never presented as the same fact, and it
 * writes an audit entry like every other override in this app.
 */
export default function StaffAttendance() {
  const { signOut, lockStaff } = useAuth();
  const today = useToday();
  const [rows, setRows] = useState<RegisterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const { data, error: e } = await supabase.rpc('attendance_register');
    if (e) setError(e.message);
    setRows((data as RegisterRow[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function setPresent(row: RegisterRow, present: boolean) {
    setError('');
    setBusy(row.student_id);
    const { error: e } = await supabase.rpc('set_attendance', {
      target: row.student_id,
      present,
      reason: present ? 'Marked by the office.' : 'Mark removed by the office.',
    });
    setBusy(null);
    if (e) return setError(e.message);
    await reload();
  }

  if (loading) return <Loading />;

  const counts = registerCounts(rows);
  // Three groups, and the ORDER is the point. Missing-and-not-excused is the
  // only one that needs a person to do something.
  const missing = rows.filter((r) => !r.present && !r.excused);
  const away = rows.filter((r) => !r.present && r.excused);
  const present = rows.filter((r) => r.present);

  return (
    <Screen>
      <Title
        sub={new Date(`${today}T12:00:00`).toLocaleDateString([], {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        })}
      >
        Attendance
      </Title>

      {/*
        "34 of 35", not "34 of 45".
        Ten students nobody expects are not a problem, and counting them as
        missing buries the one student who IS. The denominator is everyone
        expected — total minus declared absences — and an excused student who
        scanned anyway is counted in BOTH halves, because a cancelled club puts
        them visibly on the bus.
      */}
      <Card style={counts.missing > 0 ? styles.alarm : undefined}>
        <Text style={styles.headline}>
          {counts.marked} of {counts.expected} aboard
        </Text>
        <Row style={styles.stats}>
          <Stat
            label="Not marked"
            value={String(counts.missing)}
            tone={counts.missing > 0 ? theme.danger : theme.faint}
          />
          <Stat label="Expected away" value={String(counts.away)} tone={theme.muted} />
          <Stat label="On roll" value={String(counts.total)} tone={theme.text} />
        </Row>
        {counts.missing === 0 ? (
          <Text style={styles.fine}>Everyone expected this evening has been marked.</Text>
        ) : null}
      </Card>

      <ErrorText>{error}</ErrorText>

      {rows.length === 0 ? <Empty>No active students yet.</Empty> : null}

      {missing.length > 0 ? (
        <>
          <SectionLabel>Not marked — nobody expected them away ({missing.length})</SectionLabel>
          {missing.map((r) => (
            <Card key={r.student_id}>
              <Row style={styles.between}>
                <Text style={styles.name}>{r.full_name}</Text>
                <Badge label="Not marked" tone="neutral" />
              </Row>
              <Text style={styles.fine}>
                Nobody has scanned for this student. That is the absence of a record, not a
                record of absence.
              </Text>
              <Button
                label="Mark attended"
                variant="secondary"
                loading={busy === r.student_id}
                onPress={() =>
                  alert(
                    `Mark ${r.full_name} attended?`,
                    'Use this when the student is here but could not scan — a flat phone, a forgotten one. The record will show it was marked by the office rather than scanned.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Mark attended', onPress: () => setPresent(r, true) },
                    ],
                  )
                }
              />
            </Card>
          ))}
        </>
      ) : null}

      {away.length > 0 ? (
        <>
          <SectionLabel>Expected away ({away.length})</SectionLabel>
          {away.map((r) => (
            <Card key={r.student_id} style={styles.excused}>
              <Row style={styles.between}>
                <View style={styles.grow}>
                  <Text style={styles.name}>{r.full_name}</Text>
                  <Text style={styles.fine}>
                    {r.excuse_kind ? ABSENCE_LABEL[r.excuse_kind] : 'Not riding'}
                    {r.excuse_reason ? ` · ${r.excuse_reason}` : ''}
                  </Text>
                </View>
                <Badge label="Not riding" tone="accent" />
              </Row>
            </Card>
          ))}
        </>
      ) : null}

      {/*
        Sign out lives on the Dashboard, which attendance-only mode hides — so
        the office had no way out of its own account. Same omission as the
        student side, same fix.
      */}
      <SectionLabel>Account</SectionLabel>
      <Row style={styles.wrap}>
        <Button label="Lock the portal" variant="secondary" onPress={lockStaff} />
        <Button label="Sign out" variant="ghost" onPress={signOut} />
      </Row>

      {present.length > 0 ? (
        <>
          <SectionLabel>Marked ({present.length})</SectionLabel>
          {present.map((r) => (
            <Card key={r.student_id} style={styles.done}>
              <Row style={styles.between}>
                <View style={styles.grow}>
                  <Text style={styles.name}>{r.full_name}</Text>
                  <Text style={styles.fine}>
                    {r.marked_at
                      ? new Date(r.marked_at).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })
                      : ''}
                    {r.source === 'staff' ? ' · marked by the office' : ' · scanned'}
                  </Text>
                </View>
                <Badge label="Attended" tone="success" />
              </Row>
              <Button
                label="Remove this mark"
                variant="ghost"
                loading={busy === r.student_id}
                onPress={() =>
                  alert(
                    `Remove ${r.full_name}'s mark?`,
                    'The register will show them as not marked. Only do this if it was recorded in error.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Remove',
                        style: 'destructive',
                        onPress: () => setPresent(r, false),
                      },
                    ],
                  )
                }
              />
            </Card>
          ))}
        </>
      ) : null}
    </Screen>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: tone }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  between: { justifyContent: 'space-between' },
  wrap: { flexWrap: 'wrap' },
  grow: { flex: 1 },
  stats: { gap: 0 },
  stat: { flex: 1, gap: 2 },
  headline: { fontSize: 28, fontWeight: '700', color: theme.text },
  alarm: { borderColor: theme.danger },
  excused: { borderColor: theme.border, opacity: 0.9 },
  statValue: { fontSize: 24, fontWeight: '700' },
  statLabel: { fontSize: 11, color: theme.faint },
  name: { fontSize: 16, fontWeight: '700', color: theme.text },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  done: { opacity: 0.8 },
});
