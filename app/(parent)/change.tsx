import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../src/lib/auth';
import { useOrg, useToday } from '../../src/lib/org';
import { supabase } from '../../src/lib/supabase';
import { useMyChildren } from '../../src/lib/hooks';
import { CHANGE_LABEL, formatDateSpan } from '../../src/lib/types';
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
/**
 * These are ACTIONS a parent takes, not statuses.
 *
 * The distinction matters and the UI used to blur it: the button said "Absent",
 * which is what the child *becomes*, not what the parent *does*. A parent
 * reports an absence; the student's status then becomes Absent. Naming the
 * button after the outcome makes it read like a toggle on the child rather than
 * a message to the school.
 */
const KINDS: { kind: ChangeKind; label: string; blurb: string; becomes: string }[] = [
  {
    kind: 'absent',
    label: 'Report absence',
    blurb: 'Not travelling at all — sick, appointment, or away. Covers a single day or a whole holiday.',
    becomes: 'Absent',
  },
  {
    kind: 'parent_pickup',
    label: 'Report parent pickup',
    blurb: 'They are at school, but I am collecting them myself — they must not board the van.',
    becomes: 'Parent Pickup',
  },
  {
    kind: 'club_attending',
    label: 'Attending club',
    blurb: 'Put them on the after-school club van.',
    becomes: 'Scheduled on the club run',
  },
  {
    kind: 'not_attending',
    label: 'Not attending club',
    blurb: 'Take them off the club van.',
    becomes: 'Removed from the club run',
  },
];

export default function ParentChange() {
  const { session } = useAuth();
  const { org } = useOrg();
  const { children } = useMyChildren();

  const [childId, setChildId] = useState<string | null>(null);
  // Not seeded state: the operating day arrives with the organisation row a
  // moment after mount, and a frozen initial value would hold the device's
  // guess. Follows the operation's day until somebody types over it.
  const operatingDay = useToday();
  const [pickedDate, setDate] = useState<string | null>(null);
  const date = pickedDate ?? operatingDay;
  // A holiday is one request, not twenty. Off by default because almost every
  // change really is one day, and an end date nobody wanted is a trap.
  const [multiDay, setMultiDay] = useState(false);
  const [endDate, setEndDate] = useState('');
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

  /** Both fields are typed by hand, so check them before the database has to. */
  function validate(): string | null {
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    if (!iso.test(date)) return 'Enter the first date as YYYY-MM-DD.';
    if (!multiDay) return null;
    if (!iso.test(endDate)) return 'Enter the last date as YYYY-MM-DD, or switch back to one day.';
    if (endDate < date) return 'The last day cannot be before the first day.';
    return null;
  }

  async function submit(kind: ChangeKind) {
    if (!childId || !session) return;

    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }

    setError('');
    setBusy(true);

    const span = multiDay && endDate !== date ? endDate : null;

    const { error: e } = await supabase.from('change_requests').insert({
      student_id: childId,
      date,
      end_date: span,
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
      span ? 'Sent — every day covered' : 'Sent',
      span
        ? `${nameFor(childId)} is off from ${date} to ${span}. That is one request, not one per day — the driver's roster updates for each of those days as it is built.`
        : 'Before the cutoff this applies straight away and the driver sees it. After the cutoff a coordinator has to approve it.',
    );
  }

  if (!children.length) {
    return (
      <Screen>
        <Title sub="Link a child first.">Report a change</Title>
        <Empty>No children linked. Use the More tab.</Empty>
      </Screen>
    );
  }

  const nameFor = (id: string) => children.find((c) => c.id === id)?.full_name ?? 'Child';

  return (
    <Screen>
      <Title sub="Tell the school before the van sets off. The driver's roster updates automatically.">Report a change</Title>

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

        <Row style={styles.wrap}>
          <Pressable
            onPress={() => setMultiDay(false)}
            style={[styles.chip, !multiDay && styles.chipActive]}
          >
            <Text style={[styles.chipText, !multiDay && styles.chipTextActive]}>One day</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setMultiDay(true);
              if (!endDate) setEndDate(date);
            }}
            style={[styles.chip, multiDay && styles.chipActive]}
          >
            <Text style={[styles.chipText, multiDay && styles.chipTextActive]}>
              Holiday / several days
            </Text>
          </Pressable>
        </Row>

        <Field
          label={multiDay ? 'First day away' : 'Date'}
          value={date}
          onChangeText={setDate}
          placeholder="YYYY-MM-DD"
        />
        {multiDay ? (
          <>
            <Field
              label="Last day away"
              value={endDate}
              onChangeText={setEndDate}
              placeholder="YYYY-MM-DD"
            />
            <Text style={styles.span}>
              {/^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{4}-\d{2}-\d{2}$/.test(endDate) && endDate >= date
                ? `${formatDateSpan(date, endDate)} — one request covers all of it, weekends and holidays included.`
                : 'Enter both dates as YYYY-MM-DD.'}
            </Text>
          </>
        ) : null}

        <Field
          label="Reason (optional)"
          value={reason}
          onChangeText={setReason}
          placeholder={multiDay ? 'Family holiday' : "Doctor's appointment"}
        />
        <Text style={styles.fine}>
          Absence cutoff {org?.morning_cutoff?.slice(0, 5) ?? '06:30'} · pickup and club cutoff{' '}
          {org?.afternoon_cutoff?.slice(0, 5) ?? '13:30'}. Before the cutoff it applies
          automatically; after it, the office reviews it.
          {multiDay
            ? ' For several days, only the first day is judged against the cutoff — book ahead and it is always in time.'
            : ''}
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
            {/* The action is what you do; this is what your child becomes. Say
                both, so nobody has to guess what the button will actually cause. */}
            <Text style={styles.becomes}>
              {nameFor(childId ?? '')} will show as “{k.becomes}”
            </Text>
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
                  {formatDateSpan(r.date, r.end_date)}
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
  becomes: { fontSize: 12, color: theme.accent, lineHeight: 17 },
  span: { fontSize: 12, color: theme.accent, lineHeight: 17 },
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
