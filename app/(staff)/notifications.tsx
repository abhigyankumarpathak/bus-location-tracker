import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../src/lib/auth';
import { supabase } from '../../src/lib/supabase';
import { useNotifications } from '../../src/lib/hooks';
import { CHANGE_LABEL, formatDateSpan } from '../../src/lib/types';
import type { Announcement, AssignmentRequest, ChangeRequest, Profile } from '../../src/lib/types';
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
 * The office's own feed: what the system has told them, and what is waiting on
 * a decision.
 *
 * Split out from what is now the Exceptions tab, because the two were doing
 * genuinely different jobs in one list. This screen is the STREAM — routine
 * things that happened, and approvals somebody has to get round to. Nothing here
 * means anything is broken.
 *
 * Anything that IS broken — a child unaccounted for, a van that never started, a
 * push that never arrived — lives on Exceptions, so that tab can be read as
 * "this needs me now" rather than scrolled past.
 */
export default function StaffNotifications() {
  const { profile, session } = useAuth();
  const { items, unread, markAllRead, acknowledge } = useNotifications(session?.user.id);

  const [requests, setRequests] = useState<ChangeRequest[]>([]);
  const [assignmentReqs, setAssignmentReqs] = useState<AssignmentRequest[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [people, setPeople] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [{ data: cr }, { data: ar }, { data: an }, { data: pr }] = await Promise.all([
      supabase.from('change_requests').select('*').eq('approval', 'pending').order('created_at'),
      supabase.from('assignment_requests').select('*').eq('status', 'pending').order('created_at'),
      supabase.from('announcements').select('*').order('created_at', { ascending: false }).limit(10),
      supabase.from('profiles').select('*'),
    ]);
    setRequests((cr as ChangeRequest[]) ?? []);
    setAssignmentReqs((ar as AssignmentRequest[]) ?? []);
    setAnnouncements((an as Announcement[]) ?? []);
    setPeople((pr as Profile[]) ?? []);
    setLoading(false);
  }, []);

  // Tabs stay mounted, so a mount-only fetch never refreshes. Refetch on focus.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const nameOf = (id: string | null) => people.find((p) => p.id === id)?.full_name ?? 'Unknown';

  async function decide(request: ChangeRequest, approved: boolean) {
    setError('');
    const { error: e } = await supabase
      .from('change_requests')
      .update({
        approval: approved ? 'approved' : 'rejected',
        reviewed_by: profile?.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', request.id);

    if (e) {
      setError(e.message);
      return;
    }

    if (request.requested_by) {
      await supabase.from('notifications').insert({
        user_id: request.requested_by,
        title: approved ? 'Change approved' : 'Change not approved',
        body: `${CHANGE_LABEL[request.kind]} for ${formatDateSpan(request.date, request.end_date)} was ${approved ? 'approved' : 'rejected'}.`,
        kind: 'approval',
      });
    }
    await load();
  }

  async function decideAssignment(req: AssignmentRequest, approve: boolean) {
    setError('');
    // review_assignment_request applies the change and notifies the parent in one
    // transaction — the client never writes the students table directly.
    const { error: e } = await supabase.rpc('review_assignment_request', {
      request_id: req.id,
      approve,
      note: null,
    });
    if (e) {
      setError(e.message);
      return;
    }
    await load();
  }

  if (loading) return <Loading />;

  const decisions = requests.length + assignmentReqs.length;
  const toneFor = (kind: string) => {
    if (kind.startsWith('no_show') || kind === 'unable_to_drop_off' || kind === 'watchdog')
      return 'danger';
    if (kind === 'delay' || kind === 'approval' || kind === 'boarded_after_away') return 'warn';
    if (kind === 'dropped_off' || kind === 'boarded') return 'success';
    return 'accent';
  };

  return (
    <Screen>
      <Row style={styles.between}>
        <Title sub="What the system has told you, and what is waiting on you.">Notifications</Title>
        {unread > 0 ? (
          <Button label={`Mark read (${unread})`} variant="ghost" onPress={markAllRead} />
        ) : null}
      </Row>

      <ErrorText>{error}</ErrorText>

      {decisions > 0 ? (
        <>
          <SectionLabel>Waiting on your decision</SectionLabel>

          {requests.map((r) => (
            <Card key={r.id}>
              <Row style={styles.between}>
                <View style={styles.grow}>
                  <Text style={styles.name}>
                    {nameOf(r.student_id)} · {CHANGE_LABEL[r.kind]}
                  </Text>
                  <Text style={styles.fine}>
                    {formatDateSpan(r.date, r.end_date)} · asked by {nameOf(r.requested_by)}
                    {r.reason ? ` · ${r.reason}` : ''}
                  </Text>
                </View>
                <Badge label="Pending" tone="warn" />
              </Row>
              <Text style={styles.fine}>
                This one needs you because the van had already started when it was sent. Anything
                asked before the trip starts is approved automatically.
              </Text>
              <Row>
                <Button label="Approve" onPress={() => decide(r, true)} style={styles.grow} />
                <Button
                  label="Reject"
                  variant="danger"
                  onPress={() => decide(r, false)}
                  style={styles.grow}
                />
              </Row>
            </Card>
          ))}

          {assignmentReqs.map((r) => (
            <Card key={r.id}>
              <Row style={styles.between}>
                <View style={styles.grow}>
                  <Text style={styles.name}>{nameOf(r.student_id)} · hub or school change</Text>
                  <Text style={styles.fine}>
                    asked by {nameOf(r.requested_by)}
                    {r.reason ? ` · ${r.reason}` : ''}
                  </Text>
                </View>
                <Badge label="Pending" tone="warn" />
              </Row>
              <Text style={styles.fine}>
                Approving updates the student. If the new hub is not on their current route, re-seat
                them on the Setup tab.
              </Text>
              <Row>
                <Button
                  label="Approve"
                  onPress={() => decideAssignment(r, true)}
                  style={styles.grow}
                />
                <Button
                  label="Reject"
                  variant="danger"
                  onPress={() => decideAssignment(r, false)}
                  style={styles.grow}
                />
              </Row>
            </Card>
          ))}
        </>
      ) : null}

      <SectionLabel>Your feed</SectionLabel>
      {items.length === 0 ? (
        <Empty>Nothing yet. Boardings, delays, watchdog alerts and incidents appear here.</Empty>
      ) : (
        items.map((n) => (
          <Card key={n.id}>
            <Row style={styles.between}>
              <Text style={styles.name}>{n.title}</Text>
              <Badge
                label={
                  n.read_at
                    ? new Date(n.created_at).toLocaleTimeString([], {
                        hour: 'numeric',
                        minute: '2-digit',
                      })
                    : 'New'
                }
                tone={n.read_at ? 'neutral' : toneFor(n.kind)}
              />
            </Row>
            <Text style={styles.body}>{n.body}</Text>

            {/* The urgent kinds are not delivered until a person says they saw
                them — and if nobody does, the watchdog raises it on Exceptions. */}
            {n.requires_ack && !n.acknowledged_at ? (
              <Button label="I have seen this" onPress={() => acknowledge(n.id)} />
            ) : null}
          </Card>
        ))
      )}

      {announcements.length > 0 ? (
        <>
          <SectionLabel>Announcements you have sent</SectionLabel>
          {announcements.map((a) => (
            <Card key={a.id}>
              <Text style={styles.name}>{a.title}</Text>
              <Text style={styles.body}>{a.body}</Text>
              <Text style={styles.fine}>{new Date(a.created_at).toLocaleString()}</Text>
            </Card>
          ))}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  between: { justifyContent: 'space-between', alignItems: 'center' },
  grow: { flex: 1 },
  name: { fontSize: 15, fontWeight: '700', color: theme.text, flexShrink: 1 },
  body: { fontSize: 14, color: theme.muted, lineHeight: 20 },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
});
