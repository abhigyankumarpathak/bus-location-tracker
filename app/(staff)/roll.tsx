import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../src/lib/auth';
import { supabase } from '../../src/lib/supabase';
import type { RollRow } from '../../src/lib/types';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorText,
  Field,
  Loading,
  Row,
  Screen,
  SectionLabel,
  Title,
  theme,
} from '../../src/components/ui';

/**
 * Who can scan, and who answers for whoever cannot.
 *
 * Two flags per student, and the second only matters because of the first.
 * A rider without a phone can never mark themselves present, so without a
 * monitor they appear in the register as MISSING every single evening —
 * indistinguishable from a child who should be there and is not. Ten of those
 * would bury one real absence nightly, and a register that cries wolf is a
 * register nobody reads.
 *
 * The division between monitors is COMPUTED, not stored: both lists are ordered
 * by name and dealt round-robin, so it re-balances the moment either changes. A
 * stored assignment would rot into "this child is on nobody's list", which is
 * the exact failure being fixed.
 */
export default function StaffRoll() {
  const { isAdmin } = useAuth();
  const [rows, setRows] = useState<RollRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');

  const reload = useCallback(async () => {
    const { data, error: e } = await supabase.rpc('attendance_roll');
    if (e) setError(e.message);
    setRows((data as RollRow[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function setFlags(row: RollRow, phone: boolean | null, monitor: boolean | null) {
    setError('');
    setBusy(row.student_id);
    const { error: e } = await supabase.rpc('set_student_flags', {
      target: row.student_id,
      phone,
      monitor,
    });
    setBusy(null);
    if (e) return setError(e.message);
    await reload();
  }

  if (loading) return <Loading />;

  const q = filter.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.full_name.toLowerCase().includes(q)) : rows;

  const monitors = rows.filter((r) => r.is_monitor);
  const noPhone = rows.filter((r) => !r.has_phone && !r.is_monitor);
  const unassigned = noPhone.filter((r) => !r.answers_to);

  return (
    <Screen>
      <Title sub="Who can scan, and who answers for whoever cannot.">Riders</Title>

      <Card style={unassigned.length > 0 ? styles.alarm : undefined}>
        <Row style={styles.stats}>
          <Stat label="Monitors" value={String(monitors.length)} tone={theme.warn} />
          <Stat label="Without a phone" value={String(noPhone.length)} tone={theme.accent} />
          <Stat label="On roll" value={String(rows.length)} tone={theme.text} />
        </Row>
        {monitors.length === 0 && noPhone.length > 0 ? (
          <Text style={styles.warn}>
            ⚠ {noPhone.length} {noPhone.length === 1 ? 'rider' : 'riders'} cannot scan and there
            are no monitors. They will show as missing in the register every evening. Make at
            least one student a monitor.
          </Text>
        ) : monitors.length > 0 ? (
          <Text style={styles.fine}>
            Divided evenly — about {Math.ceil(noPhone.length / monitors.length)} each. The split
            re-balances on its own when either list changes.
          </Text>
        ) : null}
      </Card>

      <ErrorText>{error}</ErrorText>

      {!isAdmin ? (
        <Card>
          <Text style={styles.fine}>
            Coordinators can see this. Only an administrator can change it.
          </Text>
        </Card>
      ) : null}

      <Field
        label="Find a student"
        value={filter}
        onChangeText={setFilter}
        placeholder="Name"
        autoCapitalize="words"
      />

      {shown.length === 0 ? <Empty>Nobody matches that.</Empty> : null}

      <SectionLabel>Students ({shown.length})</SectionLabel>
      {shown.map((r) => (
        <Card key={r.student_id} style={r.is_monitor ? styles.monitorCard : undefined}>
          <Row style={styles.between}>
            <View style={styles.grow}>
              <Text style={styles.name}>{r.full_name}</Text>
              <Text style={styles.fine}>
                {r.is_monitor
                  ? 'Bus monitor'
                  : r.has_phone
                    ? 'Scans for themselves'
                    : r.answers_to
                      ? `Answered for by ${r.answers_to}`
                      : 'Cannot scan — nobody assigned'}
              </Text>
            </View>
            {r.is_monitor ? (
              <Badge label="Monitor" tone="warn" />
            ) : !r.has_phone ? (
              <Badge label={r.answers_to ? 'No phone' : 'Unassigned'} tone={r.answers_to ? 'accent' : 'danger'} />
            ) : null}
          </Row>

          {isAdmin ? (
            <Row style={styles.wrap}>
              <Button
                label={r.has_phone ? 'Mark as no phone' : 'Has a phone'}
                variant="secondary"
                loading={busy === r.student_id}
                onPress={() => setFlags(r, !r.has_phone, null)}
              />
              <Button
                label={r.is_monitor ? 'Not a monitor' : 'Make bus monitor'}
                variant={r.is_monitor ? 'ghost' : 'secondary'}
                loading={busy === r.student_id}
                onPress={() => setFlags(r, null, !r.is_monitor)}
              />
            </Row>
          ) : null}

          {isAdmin && r.is_monitor && !r.has_phone ? (
            <Text style={styles.warn}>
              This student is a monitor and is also marked as having no phone. Monitors are
              excluded from the lists they check, so nobody is confirming them.
            </Text>
          ) : null}
        </Card>
      ))}
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
  grow: { flex: 1 },
  wrap: { flexWrap: 'wrap' },
  stats: { gap: 0 },
  stat: { flex: 1, gap: 2 },
  statValue: { fontSize: 24, fontWeight: '700' },
  statLabel: { fontSize: 11, color: theme.faint },
  name: { fontSize: 16, fontWeight: '700', color: theme.text },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  warn: { fontSize: 12, color: theme.warn, lineHeight: 17 },
  alarm: { borderColor: theme.danger },
  monitorCard: { borderColor: theme.warn },
});
