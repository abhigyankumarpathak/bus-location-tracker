import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../src/lib/auth';
import { supabase } from '../../src/lib/supabase';
import type { RollRow } from '../../src/lib/types';
import { alert } from '../../src/lib/alert';
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

  /** Adding a rider who will never sign in. */
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  /** Linking a parent to one. */
  const [linkFor, setLinkFor] = useState<RollRow | null>(null);
  const [parents, setParents] = useState<{ id: string; full_name: string }[]>([]);
  const [guardians, setGuardians] = useState<{ parent_id: string; parent_name: string }[]>([]);

  const reload = useCallback(async () => {
    const { data, error: e } = await supabase.rpc('attendance_roll');
    if (e) setError(e.message);
    setRows((data as RollRow[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  /**
   * Create a roster record for a rider with no phone.
   *
   * Goes through an edge function, not a client insert: creating an account
   * needs the service role, and the function mints and redeems a single-use
   * invite server-side so handle_new_user() runs exactly as it does for a real
   * signup. No new door, just a new way through the existing one.
   */
  async function addRider() {
    const name = newName.trim();
    if (name.length < 2) return setError('Enter their full name.');

    setError('');
    setAdding(true);
    const { data, error: e } = await supabase.functions.invoke('admin-create-student', {
      body: { full_name: name },
    });
    setAdding(false);

    if (e) return setError(e.message);
    if ((data as { error?: string })?.error) return setError((data as { error: string }).error);

    setNewName('');
    await reload();
    alert(
      'Added',
      `${name} is on the roll and marked as having no phone. Link a parent so their family can see it — they cannot search for this rider themselves.`,
    );
  }

  async function openLink(row: RollRow) {
    setLinkFor(row);
    const [{ data: ps }, { data: gs }] = await Promise.all([
      supabase.rpc('all_parents'),
      supabase.rpc('student_guardians', { target: row.student_id }),
    ]);
    setParents((ps as { id: string; full_name: string }[]) ?? []);
    setGuardians((gs as { parent_id: string; parent_name: string }[]) ?? []);
  }

  async function link(parentId: string) {
    if (!linkFor) return;
    setBusy(linkFor.student_id);
    const { error: e } = await supabase.rpc('staff_link_guardian', {
      student: linkFor.student_id,
      parent: parentId,
    });
    setBusy(null);
    if (e) return setError(e.message);
    await openLink(linkFor);
  }

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

      {/*
        Adding a rider who will never sign in.

        Name only — no email to collect, no password to transmit, and nothing
        for them to do. They exist so a monitor has somebody to tick and their
        parents have something to see, which was impossible while the only route
        in was a signup they could not perform.
      */}
      {isAdmin ? (
        <>
          <SectionLabel>Add a rider without a phone</SectionLabel>
          <Card>
            <Field
              label="Full name"
              value={newName}
              onChangeText={setNewName}
              placeholder="Sai Durasala"
              autoCapitalize="words"
            />
            <Button label="Add to the roll" loading={adding} onPress={addRider} />
            <Text style={styles.fine}>
              They get a record but never an account — no sign-in, no password. Marked as having
              no phone automatically, so a monitor picks them up straight away.
            </Text>
          </Card>
        </>
      ) : null}

      {/* Linking a family, because these riders cannot be searched for. */}
      {linkFor ? (
        <>
          <SectionLabel>Parents for {linkFor.full_name}</SectionLabel>
          <Card>
            {guardians.length > 0 ? (
              guardians.map((g) => (
                <Text key={g.parent_id} style={styles.name}>
                  ✓ {g.parent_name}
                </Text>
              ))
            ) : (
              <Text style={styles.fine}>
                Nobody linked yet. Their family cannot see whether they boarded until somebody is.
              </Text>
            )}
            <Text style={styles.fine}>
              This rider has a placeholder email, so a parent cannot find them by searching — the
              office has to make the link.
            </Text>
            <Row style={styles.wrap}>
              {parents
                .filter((p) => !guardians.some((g) => g.parent_id === p.id))
                .map((p) => (
                  <Button
                    key={p.id}
                    label={p.full_name}
                    variant="secondary"
                    loading={busy === linkFor.student_id}
                    onPress={() => link(p.id)}
                  />
                ))}
            </Row>
            <Button label="Done" variant="ghost" onPress={() => setLinkFor(null)} />
          </Card>
        </>
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
              <Button label="Parents" variant="ghost" onPress={() => openLink(r)} />
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
