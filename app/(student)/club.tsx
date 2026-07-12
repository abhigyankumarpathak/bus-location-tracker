import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../src/lib/auth';
import { useOrg } from '../../src/lib/org';
import { supabase } from '../../src/lib/supabase';
import { today } from '../../src/lib/hooks';
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
 * Club status (blueprint §4.1).
 *
 * A club change affects who is on the club van, so it is not applied blindly:
 * before the afternoon cutoff it takes effect immediately; after it, the
 * database marks it Pending and a coordinator decides. The student sees which
 * happened.
 */
const OPTIONS: { kind: ChangeKind; label: string; blurb: string }[] = [
  { kind: 'club_attending', label: 'Attending club', blurb: 'Put me on the club van today.' },
  { kind: 'club_cancelled', label: 'Club cancelled', blurb: 'The club is not running today.' },
  { kind: 'not_attending', label: 'Not attending', blurb: 'I am not going to club today.' },
  { kind: 'parent_pickup', label: 'Parent pickup', blurb: 'A parent is collecting me instead.' },
];

export default function StudentClub() {
  const { session } = useAuth();
  const { org } = useOrg();
  const me = session?.user.id;

  const [date, setDate] = useState(today());
  const [requests, setRequests] = useState<ChangeRequest[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('change_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);
    setRequests((data as ChangeRequest[]) ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function submit(kind: ChangeKind) {
    if (!me) return;
    setError('');
    setBusy(true);

    // The trigger decides auto_approved vs pending from the cutoff — the client
    // does not get a say, which is the point.
    const { error: e } = await supabase
      .from('change_requests')
      .insert({ student_id: me, date, kind, requested_by: me });

    setBusy(false);
    if (e) {
      setError(e.message);
      return;
    }

    await load();
    Alert.alert('Sent', 'If it is before the cutoff it applies straight away, otherwise the transport office will review it.');
  }

  return (
    <Screen>
      <Title sub="Tell the office whether you are on the club van.">Club status</Title>

      <Card>
        <Field label="Date" value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" />
        <Text style={styles.fine}>
          Cutoff is {org?.afternoon_cutoff?.slice(0, 5) ?? '13:30'}. Changes made before it apply
          automatically. Later ones wait for a coordinator to approve.
        </Text>
      </Card>

      <SectionLabel>Set my plan</SectionLabel>
      {OPTIONS.map((o) => (
        <Pressable
          key={o.kind}
          disabled={busy}
          onPress={() => submit(o.kind)}
          style={({ pressed }) => [styles.option, pressed && { opacity: 0.7 }]}
        >
          <View style={styles.grow}>
            <Text style={styles.optionTitle}>{o.label}</Text>
            <Text style={styles.fine}>{o.blurb}</Text>
          </View>
          <Text style={styles.chev}>›</Text>
        </Pressable>
      ))}

      <ErrorText>{error}</ErrorText>

      <SectionLabel>What you have asked for</SectionLabel>
      {requests.length === 0 ? (
        <Empty>Nothing requested yet.</Empty>
      ) : (
        requests.map((r) => (
          <Card key={r.id}>
            <Row style={styles.between}>
              <View style={styles.grow}>
                <Text style={styles.optionTitle}>{CHANGE_LABEL[r.kind]}</Text>
                <Text style={styles.fine}>{r.date}</Text>
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
                  r.approval === 'pending' ? 'warn' : r.approval === 'rejected' ? 'danger' : 'success'
                }
              />
            </Row>
            {r.approval === 'pending' ? (
              <Text style={styles.fine}>
                Sent after the cutoff, so the transport office has to approve it.
              </Text>
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
  grow: { flex: 1 },
  between: { justifyContent: 'space-between' },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
});
