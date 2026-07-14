import { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, StyleSheet, Text, View } from 'react-native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import type { Profile, Role } from '../lib/types';
import { Badge, Button, Card, Empty, ErrorText, Field, Row, SectionLabel, theme } from './ui';

/**
 * Parent ↔ student linking.
 *
 * A link is a REQUEST the other side accepts. If either party could assert one
 * unilaterally, anyone who knew a student's phone number could make themselves
 * that child's parent and start watching them. RLS enforces the consent, not
 * just this screen: the accept policy requires `requested_by <> auth.uid()`.
 *
 * The lookup goes through a security-definer function that matches one exact
 * email or phone and returns one row. The profiles table itself is not
 * searchable — otherwise any user could enumerate every student in the school.
 */
interface LinkRow {
  id: string;
  parent_id: string;
  student_id: string;
  status: string;
  requested_by: string;
  other: Pick<Profile, 'id' | 'full_name' | 'phone' | 'role'> | null;
}

export function FamilyLinks({ perspective }: { perspective: 'student' | 'parent' }) {
  const { session } = useAuth();
  const me = session?.user.id;
  const wanted: Role = perspective === 'student' ? 'parent' : 'student';
  const noun = wanted === 'parent' ? 'parent' : 'child';

  const [links, setLinks] = useState<LinkRow[]>([]);
  const [contact, setContact] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!me) return;
    const { data } = await supabase.from('guardian_links').select('*');
    const rows = (data as LinkRow[]) ?? [];

    // Names come from my_link_counterparts(), not from `profiles` directly.
    // Reading the profile of a parent or child is only permitted once the link
    // is ACCEPTED, so querying the table here named nobody while a request was
    // still pending — which is exactly when a name matters most. The function
    // hands back the name for a pending link and holds the phone number until
    // the other person has actually agreed.
    const { data: people } = await supabase.rpc('my_link_counterparts');
    const profiles = (people as LinkRow['other'][] | null) ?? [];

    setLinks(
      rows.map((r) => {
        const otherId = r.parent_id === me ? r.student_id : r.parent_id;
        return { ...r, other: profiles.find((p) => p?.id === otherId) ?? null };
      }),
    );
  }, [me]);

  useEffect(() => {
    load();
  }, [load]);

  async function onAdd() {
    if (!me) return;
    setError('');
    setBusy(true);
    try {
      const { data, error: rpcError } = await supabase.rpc('find_user_by_contact', { contact });
      if (rpcError) throw new Error(rpcError.message);

      const found = (data as { id: string; full_name: string; role: Role }[] | null)?.[0];
      if (!found) {
        throw new Error(
          `No approved ${wanted} with that email or phone. They must have signed up and been approved first.`,
        );
      }
      if (found.role !== wanted) {
        throw new Error(`${found.full_name} is signed up as a ${found.role}, not a ${wanted}.`);
      }

      const { error: insertError } = await supabase.from('guardian_links').insert({
        parent_id: perspective === 'parent' ? me : found.id,
        student_id: perspective === 'student' ? me : found.id,
        requested_by: me,
      });
      if (insertError) {
        throw new Error(
          insertError.code === '23505'
            ? `You are already linked to ${found.full_name}, or a request is pending.`
            : insertError.message,
        );
      }

      setContact('');
      Alert.alert('Request sent', `${found.full_name} has to accept before you are linked.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the request.');
    } finally {
      setBusy(false);
    }
  }

  async function onAccept(link: LinkRow) {
    await supabase.from('guardian_links').update({ status: 'accepted' }).eq('id', link.id);
    await load();
  }

  function onRemove(link: LinkRow) {
    Alert.alert('Remove link?', `This unlinks you from ${link.other?.full_name ?? 'this person'}.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await supabase.from('guardian_links').delete().eq('id', link.id);
          await load();
        },
      },
    ]);
  }

  function call(phone: string | null) {
    if (!phone) {
      Alert.alert('No phone number', 'This person has not added one.');
      return;
    }
    Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`);
  }

  const accepted = links.filter((l) => l.status === 'accepted');
  const incoming = links.filter((l) => l.status === 'pending' && l.requested_by !== me);
  const outgoing = links.filter((l) => l.status === 'pending' && l.requested_by === me);

  return (
    <>
      <Card>
        <Field
          label={`Link a ${noun}`}
          value={contact}
          onChangeText={setContact}
          autoCapitalize="none"
          keyboardType="email-address"
          placeholder="Their email or phone number"
        />
        <Text style={styles.hint}>
          They must already have an approved account. They have to accept before the link is active.
        </Text>
        <ErrorText>{error}</ErrorText>
        <Button label="Send request" onPress={onAdd} loading={busy} disabled={!contact.trim()} />
      </Card>

      {incoming.length > 0 && (
        <>
          <SectionLabel>Waiting for you</SectionLabel>
          {incoming.map((link) => (
            <Card key={link.id}>
              <Text style={styles.name}>{link.other?.full_name ?? 'Someone'}</Text>
              <Text style={styles.sub}>wants to be linked to you.</Text>
              <Row>
                <Button label="Accept" onPress={() => onAccept(link)} style={styles.grow} />
                <Button label="Decline" variant="danger" onPress={() => onRemove(link)} style={styles.grow} />
              </Row>
            </Card>
          ))}
        </>
      )}

      <SectionLabel>{wanted === 'parent' ? 'My parents' : 'My children'}</SectionLabel>

      {accepted.length === 0 && outgoing.length === 0 ? <Empty>No {noun}s linked yet.</Empty> : null}

      {accepted.map((link) => (
        <Card key={link.id}>
          <Row style={styles.between}>
            <View style={styles.grow}>
              <Text style={styles.name}>{link.other?.full_name ?? 'Unknown'}</Text>
              <Text style={styles.sub}>{link.other?.phone ?? 'No phone number'}</Text>
            </View>
            <Badge label="Linked" tone="success" />
          </Row>
          <Row>
            <Button label="Call" onPress={() => call(link.other?.phone ?? null)} style={styles.grow} />
            <Button label="Unlink" variant="danger" onPress={() => onRemove(link)} />
          </Row>
        </Card>
      ))}

      {outgoing.map((link) => (
        <Card key={link.id}>
          <Row style={styles.between}>
            <View style={styles.grow}>
              <Text style={styles.name}>{link.other?.full_name ?? 'Unknown'}</Text>
              <Text style={styles.sub}>Waiting for them to accept.</Text>
            </View>
            <Badge label="Pending" tone="warn" />
          </Row>
          <Button label="Cancel request" variant="danger" onPress={() => onRemove(link)} />
        </Card>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  name: { fontSize: 16, fontWeight: '700', color: theme.text },
  sub: { fontSize: 13, color: theme.muted },
  grow: { flex: 1 },
  between: { justifyContent: 'space-between' },
});
