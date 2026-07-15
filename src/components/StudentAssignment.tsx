import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useReference } from '../lib/hooks';
import type { AssignmentRequest, Profile, Student } from '../lib/types';
import { Badge, Button, Card, ErrorText, Field, Row, theme } from './ui';

/**
 * A parent proposing where their child rides FROM — the morning and afternoon
 * hubs and the school. It never changes anything directly: it files a request
 * the transport office approves, because a hub change is how a child ends up on
 * a different bus, and the office decides which bus serves a hub.
 *
 * The parent picks from the hubs and schools the office has already created —
 * they cannot invent a pickup point. RLS lets a guardian read their own child's
 * record and file a request for them, and nothing else.
 */
export function StudentAssignment({ child }: { child: Pick<Profile, 'id' | 'full_name'> }) {
  const { session } = useAuth();
  const me = session?.user.id;
  const ref = useReference();

  const [student, setStudent] = useState<Student | null>(null);
  const [pending, setPending] = useState<AssignmentRequest | null>(null);

  const [editing, setEditing] = useState(false);
  const [schoolId, setSchoolId] = useState<string | null>(null);
  const [morningHub, setMorningHub] = useState<string | null>(null);
  const [afternoonHub, setAfternoonHub] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const { data: s } = await supabase
      .from('students')
      .select('*')
      .eq('student_id', child.id)
      .maybeSingle();
    setStudent((s as Student) ?? null);

    const { data: reqs } = await supabase
      .from('assignment_requests')
      .select('*')
      .eq('student_id', child.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1);
    setPending((reqs as AssignmentRequest[])?.[0] ?? null);
  }, [child.id]);

  useEffect(() => {
    load();
  }, [load]);

  function startEdit() {
    setSchoolId(student?.school_id ?? null);
    setMorningHub(student?.morning_hub_id ?? null);
    setAfternoonHub(student?.afternoon_hub_id ?? null);
    setReason('');
    setError('');
    setEditing(true);
  }

  const unchanged =
    schoolId === (student?.school_id ?? null) &&
    morningHub === (student?.morning_hub_id ?? null) &&
    afternoonHub === (student?.afternoon_hub_id ?? null);

  async function submit() {
    setBusy(true);
    setError('');
    // The whole desired assignment is sent, prefilled from the current one, so
    // the office applies all three fields at once on approval.
    const { error: e } = await supabase.from('assignment_requests').insert({
      student_id: child.id,
      requested_by: me,
      school_id: schoolId,
      morning_hub_id: morningHub,
      afternoon_hub_id: afternoonHub,
      reason: reason.trim() || null,
    });
    setBusy(false);
    if (e) return setError(e.message);
    setEditing(false);
    await load();
  }

  async function cancel() {
    if (!pending) return;
    await supabase.from('assignment_requests').delete().eq('id', pending.id);
    await load();
  }

  const schoolName = (id: string | null) => ref.schoolOf(id)?.name ?? 'Not set';
  const hubName = (id: string | null) => ref.hubOf(id)?.name ?? 'Not set';

  return (
    <Card>
      <Row style={styles.between}>
        <Text style={styles.name}>{child.full_name}</Text>
        {pending ? <Badge label="Change pending" tone="warn" /> : null}
      </Row>

      <Detail label="School" value={schoolName(student?.school_id ?? null)} />
      <Detail label="Morning hub" value={hubName(student?.morning_hub_id ?? null)} />
      <Detail label="Afternoon hub" value={hubName(student?.afternoon_hub_id ?? null)} />

      {pending ? (
        <View style={styles.pending}>
          <Text style={styles.fine}>Requested — waiting for the transport office:</Text>
          <Detail label="School" value={schoolName(pending.school_id)} />
          <Detail label="Morning hub" value={hubName(pending.morning_hub_id)} />
          <Detail label="Afternoon hub" value={hubName(pending.afternoon_hub_id)} />
          {pending.reason ? <Text style={styles.fine}>“{pending.reason}”</Text> : null}
          <Button label="Cancel request" variant="ghost" onPress={cancel} />
        </View>
      ) : editing ? (
        <View style={styles.editor}>
          <Picker
            label="School"
            options={ref.schools.map((s) => ({ id: s.id, name: s.name }))}
            selected={schoolId}
            onSelect={setSchoolId}
          />
          <Picker
            label="Morning hub"
            options={ref.hubs.map((h) => ({ id: h.id, name: h.name }))}
            selected={morningHub}
            onSelect={setMorningHub}
          />
          <Picker
            label="Afternoon hub"
            options={ref.hubs.map((h) => ({ id: h.id, name: h.name }))}
            selected={afternoonHub}
            onSelect={setAfternoonHub}
          />
          <Field
            label="Why (optional)"
            value={reason}
            onChangeText={setReason}
            placeholder="We've moved — the Oak Street hub is closer now."
          />
          <ErrorText>{error}</ErrorText>
          <Row style={styles.wrap}>
            <Button
              label="Send for approval"
              onPress={submit}
              loading={busy}
              disabled={unchanged}
              style={styles.grow}
            />
            <Button label="Cancel" variant="ghost" onPress={() => setEditing(false)} />
          </Row>
          {unchanged ? (
            <Text style={styles.fine}>Change a hub or the school to send a request.</Text>
          ) : null}
        </View>
      ) : (
        <Button label="Request a change" variant="secondary" onPress={startEdit} />
      )}
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <Row style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </Row>
  );
}

function Picker({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: { id: string; name: string }[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <View style={styles.picker}>
      <Text style={styles.pickerLabel}>{label}</Text>
      {options.length === 0 ? (
        <Text style={styles.fine}>None set up yet — ask the transport office.</Text>
      ) : (
        <Row style={styles.wrap}>
          {options.map((o) => (
            <Button
              key={o.id}
              label={o.name}
              variant={selected === o.id ? 'primary' : 'secondary'}
              onPress={() => onSelect(o.id)}
            />
          ))}
        </Row>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  between: { justifyContent: 'space-between', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
  grow: { flex: 1 },
  name: { fontSize: 16, fontWeight: '700', color: theme.text },
  detail: { justifyContent: 'space-between', gap: 12 },
  detailLabel: { fontSize: 13, color: theme.muted },
  detailValue: { fontSize: 13, color: theme.text, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  pending: {
    gap: 6,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    paddingTop: 10,
  },
  editor: { gap: 10, marginTop: 4 },
  picker: { gap: 6 },
  pickerLabel: { fontSize: 13, color: theme.muted, fontWeight: '600' },
});
