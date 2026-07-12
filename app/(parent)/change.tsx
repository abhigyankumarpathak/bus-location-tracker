import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../src/lib/auth';
import { useOrg } from '../../src/lib/org';
import { supabase } from '../../src/lib/supabase';
import { today, useMyChildren } from '../../src/lib/hooks';
import { CHANGE_LABEL } from '../../src/lib/types';
import type { ChangeKind, ChangeRequest } from '../../src/lib/types';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorText,
  Field,
  Row,
  Screen,
  SectionLabel,
  Title,
  theme,
} from '../../src/components/ui';

/**
 * Daily Change (blueprint §4.2).
 *
 * A parent reports an absence, a parent-pickup, or a club change. The cutoff
 * decides what happens next, and the database decides that — not this screen:
 * before the cutoff it applies immediately and the driver's roster updates;
 * after it, the request sits Pending until a coordinator approves it.
 *
 * Blueprint §4.2 also says permanent hub or address changes are NOT self-service
 * in the MVP, which is why there is nothing here for them — a parent asks the
 * office instead.
 */
const KINDS: { kind: ChangeKind; label: string; blurb: string }[] = [
  { kind: 'absent', label: 'Absent', blurb: 'Not travelling at all today.' },
  { kind: 'parent_pickup', label: 'Parent pickup', blurb: 'I am collecting them myself.' },
  { kind: 'club_attending', label: 'Attending club', blurb: 'Put them on the club van.' },
  { kind: 'not_attending', label: 'Not attending club', blurb: 'Take them off the club van.' },
];

export default function ParentChange() {
  const { session } = useAuth();
  const { org } = useOrg();
  const { children } = useMyChildren();

  const [childId, setChildId] = useState<string | null>(null);
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('');
  const [requests, setRequests] = useState<ChangeRequest[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('change_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(30);
    setRequests((data as ChangeRequest[]) ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!childId && children.length) setChildId(children[0].id);
  }, [children, childId]);

  async function submit(kind: ChangeKind) {
    if (!childId || !session) return;
    setError('');
    setBusy(true);

    const { error: e } = await supabase.from('change_requests').insert({
      student_id: childId,
      date,
      kind,
      reason: reason.trim() || null,
      requested_by: session.user.id,
    });

    setBusy(false);
    if (e) {
      setError(e.message);
      return;
    }

    setReason('');
    await load();
    Alert.alert(
      'Sent',
      'Before the cutoff this applies straight away and the driver sees it. After the cutoff a coordinator has to approve it.',
    );
  }

  if (!children.length) {
    return (
      <Screen>
        <Title sub="Link a child first.">Daily change</Title>
        <Empty>No children linked. Use the More tab.</Empty>
      </Screen>
    );
  }

  const nameFor = (id: string) => children.find((c) => c.id === id)?.full_name ?? 'Child';

  return (
    <Screen>
      <Title sub="Report an absence, a pickup, or a club change.">Daily change</Title>

      <Card>
        {children.length > 1 ? (
          <Row style={styles.wrap}>
            {children.map((c) => (
              <Pressable
                key={c.id}
                onPress={() => setChildId(c.id)}
                style={[styles.chip, childId === c.id && styles.chipActive]}
              >
                <Text style={[styles.chipText, childId === c.id && styles.chipTextActive]}>
                  {c.full_name.split(' ')[0]}
                </Text>
              </Pressable>
            ))}
          </Row>
        ) : null}

        <Field label="Date" value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" />
        <Field
          label="Reason (optional)"
          value={reason}
          onChangeText={setReason}
          placeholder="Doctor's appointment"
        />
        <Text style={styles.fine}>
          Absence cutoff {org?.morning_cutoff?.slice(0, 5) ?? '06:30'} · pickup and club cutoff{' '}
          {org?.afternoon_cutoff?.slice(0, 5) ?? '13:30'}. Before the cutoff it applies
          automatically; after it, the office reviews it.
        </Text>
      </Card>

      <ErrorText>{error}</ErrorText>

      {KINDS.map((k) => (
        <Pressable
          key={k.kind}
          disabled={busy}
          onPress={() => submit(k.kind)}
          style={({ pressed }) => [styles.option, pressed && { opacity: 0.7 }]}
        >
          <View style={styles.grow}>
            <Text style={styles.optionTitle}>{k.label}</Text>
            <Text style={styles.fine}>{k.blurb}</Text>
          </View>
          <Text style={styles.chev}>›</Text>
        </Pressable>
      ))}

      <Card>
        <Text style={styles.fine}>
          Changing a hub or a home address permanently is not self-service — ask the transport
          office and they will update it.
        </Text>
      </Card>

      <SectionLabel>Recent requests</SectionLabel>
      {requests.length === 0 ? (
        <Empty>Nothing sent yet.</Empty>
      ) : (
        requests.map((r) => (
          <Card key={r.id}>
            <Row style={styles.between}>
              <View style={styles.grow}>
                <Text style={styles.optionTitle}>
                  {nameFor(r.student_id)} · {CHANGE_LABEL[r.kind]}
                </Text>
                <Text style={styles.fine}>
                  {r.date}
                  {r.reason ? ` · ${r.reason}` : ''}
                </Text>
              </View>
              <Badge
                label={
                  r.approval === 'pending'
                    ? 'Pending'
                    : r.approval === 'rejected'
                      ? 'Rejected'
                      : 'Approved'
                }
                tone={
                  r.approval === 'pending'
                    ? 'warn'
                    : r.approval === 'rejected'
                      ? 'danger'
                      : 'success'
                }
              />
            </Row>
            {r.approval === 'pending' ? (
              <Text style={styles.fine}>Sent after the cutoff — waiting on the transport office.</Text>
            ) : null}
            {r.review_note ? <Text style={styles.fine}>Office: {r.review_note}</Text> : null}
          </Card>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  optionTitle: { fontSize: 15, fontWeight: '700', color: theme.text },
  chev: { fontSize: 22, color: theme.faint },
  chip: {
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceAlt,
  },
  chipActive: { borderColor: theme.accent },
  chipText: { color: theme.muted, fontWeight: '600', fontSize: 13 },
  chipTextActive: { color: theme.accent },
  wrap: { flexWrap: 'wrap' },
  grow: { flex: 1 },
  between: { justifyContent: 'space-between' },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
});
