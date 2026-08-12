import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { supabase } from '../../src/lib/supabase';
import type { AuditLog, Profile } from '../../src/lib/types';
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
 * The audit log, on a screen.
 *
 * Entries have been written faithfully since the first schema and NOTHING has
 * ever displayed them. The first time this matters will be a dispute about a
 * child — which is the worst possible moment to be writing SQL by hand against
 * production while a parent waits on the phone.
 *
 * Read-only by construction: the RLS policy on `audit_logs` has no insert,
 * update or delete for anybody. A log a coordinator can edit is not a log.
 */

/** The actions worth filtering by, in the words the office would use. */
const FILTERS: { value: string | null; label: string }[] = [
  { value: null, label: 'Everything' },
  { value: 'status_change', label: 'Status changes' },
  { value: 'status_undo', label: 'Undos' },
  { value: 'moved_trip', label: 'Moved vans' },
  { value: 'delay_reported', label: 'Delays' },
  { value: 'stop_progress_undo', label: 'Stop corrections' },
];

const ACTION_LABEL: Record<string, string> = {
  status_change: 'Status changed',
  status_undo: 'Taken back',
  stop_progress_undo: 'Stop corrected',
  moved_trip: 'Moved to another van',
  delay_reported: 'Delay reported',
  trip_rerun: 'Trip re-run',
  trip_deleted: 'Trip deleted',
  weekly_schedule_enabled: 'Weekly purge scheduled',
  weekly_schedule_disabled: 'Weekly purge stopped',
  watchdog_schedule_enabled: 'Watchdog scheduled',
  watchdog_schedule_disabled: 'Watchdog stopped',
};

export default function StaffAudit() {
  const [entries, setEntries] = useState<AuditLog[]>([]);
  const [people, setPeople] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [action, setAction] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    let query = supabase
      .from('audit_logs')
      .select('*')
      .order('changed_at', { ascending: false })
      .limit(200);

    if (action) query = query.eq('action', action);

    const [{ data: logs, error: e }, { data: pr }] = await Promise.all([
      query,
      supabase.from('profiles').select('*'),
    ]);

    if (e) setError(e.message);
    setEntries((logs as AuditLog[]) ?? []);
    setPeople((pr as Profile[]) ?? []);
    setLoading(false);
  }, [action]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const nameOf = (id: string | null) =>
    id ? people.find((p) => p.id === id)?.full_name ?? 'Someone (account removed)' : 'The system';

  if (loading) return <Loading />;

  // Filtering by name happens here rather than in the query: `changed_by` is an
  // id, and the office searches for "Priya", not a uuid.
  const term = search.trim().toLowerCase();
  const shown = term
    ? entries.filter((e) => {
        const who = nameOf(e.changed_by).toLowerCase();
        const what = `${e.entity_type} ${e.action} ${e.reason ?? ''}`.toLowerCase();
        const values = JSON.stringify([e.old_value, e.new_value]).toLowerCase();
        return who.includes(term) || what.includes(term) || values.includes(term);
      })
    : entries;

  const describe = (e: AuditLog) => {
    const from = e.old_value?.status;
    const to = e.new_value?.status;
    if (from || to) return `${String(from ?? '—')} → ${String(to ?? '—')}`;
    if (e.action === 'delay_reported') {
      return `+${String(e.new_value?.added ?? '?')} min (total ${String(e.new_value?.total ?? '?')})`;
    }
    if (e.action === 'stop_progress_undo') return String(e.new_value?.undone ?? 'corrected');
    return '';
  };

  return (
    <Screen>
      <Title sub="Every override, correction and status change, in order.">History</Title>

      <Card>
        <Text style={styles.body}>
          Written automatically and never editable — there is no policy on this table that lets
          anyone insert, change or delete a row, including an administrator.
        </Text>
        <Text style={styles.fine}>
          The most recent 200 entries. Incidents and overrides are kept beyond the retention
          window, so an old dispute still has its record.
        </Text>
      </Card>

      <ErrorText>{error}</ErrorText>

      <SectionLabel>Filter</SectionLabel>
      <Row style={styles.wrap}>
        {FILTERS.map((f) => (
          <Button
            key={f.label}
            label={f.label}
            variant={action === f.value ? 'primary' : 'secondary'}
            onPress={() => setAction(f.value)}
          />
        ))}
      </Row>

      <Field
        label="Search by person, reason or value"
        value={search}
        onChangeText={setSearch}
        placeholder="Priya, or “turned up”"
        autoCapitalize="none"
      />

      {shown.length === 0 ? (
        <Empty>Nothing recorded that matches.</Empty>
      ) : (
        shown.map((e) => (
          <Card key={e.id}>
            <Row style={styles.between}>
              <View style={styles.grow}>
                <Text style={styles.name}>{ACTION_LABEL[e.action] ?? e.action}</Text>
                <Text style={styles.fine}>
                  {new Date(e.changed_at).toLocaleString()} · by {nameOf(e.changed_by)}
                </Text>
              </View>
              <Badge
                label={e.entity_type.replace(/_/g, ' ')}
                tone={e.action.includes('undo') ? 'warn' : 'neutral'}
              />
            </Row>
            {describe(e) ? <Text style={styles.change}>{describe(e)}</Text> : null}
            {e.reason ? <Text style={styles.reason}>“{e.reason}”</Text> : null}
          </Card>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  between: { justifyContent: 'space-between' },
  grow: { flex: 1 },
  wrap: { flexWrap: 'wrap' },
  name: { fontSize: 15, fontWeight: '700', color: theme.text },
  body: { fontSize: 14, color: theme.muted, lineHeight: 20 },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  change: { fontSize: 14, color: theme.accent, fontWeight: '600' },
  reason: { fontSize: 13, color: theme.text, lineHeight: 19, fontStyle: 'italic' },
});
