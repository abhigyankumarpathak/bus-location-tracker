import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useAuth } from '../../src/lib/auth';
import { supabase } from '../../src/lib/supabase';
import { useReference } from '../../src/lib/hooks';
import type { Invite, Profile, Role, Student } from '../../src/lib/types';
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
 * People — creating users, and the roster.
 *
 * Blueprint §6.1: "Create and deactivate users; assign roles."
 *
 *   Admin creates the user → hands them a code → they sign up → role is assigned
 *
 * Nobody self-selects anything. The invite carries the role, and the database
 * takes it from there — a person signing up with a student code while claiming
 * to be an admin gets a student account.
 *
 * Only admins can issue invites, because issuing one IS assigning a role.
 * Coordinators can see them but not create them; RLS enforces that, so the
 * buttons failing for a coordinator is the database talking, not the UI.
 */

const DEFAULT_REASON =
  'An administrator removed your account. Contact the transport office if you think this is wrong.';

const INVITE_ROLES: Role[] = ['student', 'parent', 'driver', 'coordinator'];

/**
 * The message handed to the invitee. Sent through the OS share sheet, which is
 * how a coordinator actually gets a code to a parent — text, email, whatever
 * they already use. (The share sheet also offers Copy, which is why there is no
 * separate clipboard dependency: `expo-clipboard` is a native module, and adding
 * one forces a full native rebuild for something the share sheet already does.)
 */
function inviteMessage(role: Role, code: string) {
  return (
    `You have been invited to the school transport app as a ${role}.\n\n` +
    `Your invite code is ${code}\n\n` +
    `Open the app, tap "I have an invite code", and enter it. ` +
    `The code works once and expires in 14 days.`
  );
}

export default function StaffPeople() {
  const { profile, isAdmin } = useAuth();
  const ref = useReference();

  const [people, setPeople] = useState<Profile[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [filter, setFilter] = useState<Role | 'invites' | 'all'>('invites');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  // New invite form
  const [inviteRole, setInviteRole] = useState<Role>('student');
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [creating, setCreating] = useState(false);

  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState(DEFAULT_REASON);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: p }, { data: s }, { data: i }] = await Promise.all([
      supabase.from('profiles').select('*').order('created_at', { ascending: false }),
      supabase.from('students').select('*'),
      supabase.from('invites').select('*').order('created_at', { ascending: false }),
    ]);
    setPeople((p as Profile[]) ?? []);
    setStudents((s as Student[]) ?? []);
    setInvites((i as Invite[]) ?? []);
  }, []);

  // Refetch every time the tab is opened, not just when it first mounts.
  //
  // Tabs stay mounted in the background, so a plain useEffect ran once and never
  // again: anyone who redeemed an invite while the portal was open stayed
  // invisible until the whole app was restarted. That is exactly the moment an
  // admin is watching — they hand out a code and wait for the person to appear.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // ...and keep refetching while the invite list is actually on screen.
  //
  // A code stops being unused at a moment that happens on someone ELSE's phone.
  // The focus refetch above misses that entirely for the admin who hands out a
  // code and then sits here waiting for the person to appear: the redeemed code
  // stayed listed under "Unused codes", still shareable, until they navigated
  // away and back. Poll instead, so a code moves to "Recently used" on its own.
  useFocusEffect(
    useCallback(() => {
      if (filter !== 'invites') return;
      const timer = setInterval(load, 15_000);
      return () => clearInterval(timer);
    }, [filter, load]),
  );

  async function createInvite() {
    setError('');
    setCreating(true);

    // `code` is left out on purpose — a database trigger generates it, so two
    // admins inviting at the same moment cannot collide.
    const { data, error: e } = await supabase
      .from('invites')
      .insert({
        role: inviteRole,
        full_name: inviteName.trim(),
        email: inviteEmail.trim() || null,
        created_by: profile?.id,
      })
      .select()
      .single();

    setCreating(false);

    if (e) {
      setError(
        e.code === '42501'
          ? 'Only an administrator can invite people.'
          : e.message,
      );
      return;
    }

    const invite = data as Invite;
    setInviteName('');
    setInviteEmail('');
    await load();

    Alert.alert(
      'Invite created',
      `${invite.full_name || 'They'} can now sign up as a ${invite.role} with the code:\n\n${invite.code}\n\nIt works once and expires in 14 days.`,
      [
        { text: 'Done' },
        {
          text: 'Send it to them',
          onPress: () => Share.share({ message: inviteMessage(invite.role, invite.code) }),
        },
      ],
    );
  }

  async function revokeInvite(invite: Invite) {
    const { error: e } = await supabase
      .from('invites')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', invite.id);
    if (e) setError(e.message);
    await load();
  }

  async function setStatus(person: Profile, status: 'active' | 'suspended') {
    setError('');
    setBusyId(person.id);
    const { error: e } = await supabase.from('profiles').update({ status }).eq('id', person.id);
    setBusyId(null);

    if (e) {
      setError(
        e.message.includes('administrator') || e.code === '42501'
          ? 'Only an administrator can suspend or reactivate accounts.'
          : e.message,
      );
      return;
    }
    await load();
  }

  async function confirmRemove(person: Profile) {
    setError('');
    setBusyId(person.id);

    const { error: e } = await supabase.functions.invoke('admin-delete-user', {
      body: { user_id: person.id, reason: reason.trim() || DEFAULT_REASON },
    });

    setBusyId(null);

    if (e) {
      setError('Could not remove the account. Check the admin-delete-user function is deployed.');
      return;
    }

    setRemoving(null);
    setReason(DEFAULT_REASON);
    await load();
    Alert.alert('Removed', 'They will see your message the next time they try to sign in.');
  }

  async function updateStudent(studentId: string, patch: Partial<Student>) {
    setError('');
    const { error: e } = await supabase.from('students').update(patch).eq('student_id', studentId);
    if (e) setError(e.message);
    await load();
  }

  // "Unused" has to mean "will still work if I send it". A redeemed code leaves
  // this list the moment the database stamps used_at, and an expired one is just
  // as dead — offering "Send it to them" for either hands out a code that signup
  // will refuse.
  const now = Date.now();
  const live = (i: Invite) => !i.used_at && !i.revoked_at;
  const openInvites = invites.filter((i) => live(i) && new Date(i.expires_at).getTime() > now);
  const expiredInvites = invites.filter((i) => live(i) && new Date(i.expires_at).getTime() <= now);
  const usedInvites = invites.filter((i) => i.used_at);

  const visible = people.filter((p) => {
    if (p.role === 'admin') return false;
    if (filter === 'invites') return false;
    if (filter !== 'all' && p.role !== filter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      p.full_name.toLowerCase().includes(q) ||
      (p.email ?? '').toLowerCase().includes(q) ||
      (p.phone ?? '').includes(q)
    );
  });

  const FILTERS: { value: Role | 'invites' | 'all'; label: string }[] = [
    { value: 'invites', label: `Invites${openInvites.length ? ` (${openInvites.length})` : ''}` },
    { value: 'all', label: 'Everyone' },
    { value: 'student', label: 'Students' },
    { value: 'parent', label: 'Parents' },
    { value: 'driver', label: 'Drivers' },
    { value: 'coordinator', label: 'Coordinators' },
  ];

  return (
    <Screen>
      <Title sub="You create the account and choose the role. Nobody picks their own.">
        People
      </Title>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.value}
            onPress={() => setFilter(f.value)}
            style={[styles.chip, filter === f.value && styles.chipActive]}
          >
            <Text style={[styles.chipText, filter === f.value && styles.chipTextActive]}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <ErrorText>{error}</ErrorText>

      {filter === 'invites' ? (
        <>
          <SectionLabel>Invite someone</SectionLabel>
          <Card>
            <Text style={styles.fine}>Their role in the app. They cannot change it.</Text>
            <Row style={styles.wrap}>
              {INVITE_ROLES.map((r) => (
                <Button
                  key={r}
                  label={r}
                  variant={inviteRole === r ? 'primary' : 'secondary'}
                  onPress={() => setInviteRole(r)}
                />
              ))}
            </Row>

            <Field
              label="Their name"
              value={inviteName}
              onChangeText={setInviteName}
              placeholder="Alex Rivera"
            />
            <Field
              label="Their email (optional)"
              value={inviteEmail}
              onChangeText={setInviteEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              placeholder="alex@school.edu"
            />
            <Text style={styles.fine}>
              Leave the email blank and anyone holding the code can use it. Fill it in and the code
              only works for that address — safer if you are texting it.
            </Text>

            {inviteRole === 'coordinator' ? (
              <Text style={styles.warn}>
                ⚠ A coordinator can see every student, trip, and exception in the school. Only invite
                someone who runs transport operations.
              </Text>
            ) : null}

            <Button
              label="Create invite code"
              onPress={createInvite}
              loading={creating}
              disabled={!inviteName.trim() || !isAdmin}
            />

            {!isAdmin ? (
              <Text style={styles.fine}>
                You are a coordinator. Only administrators can invite people — issuing an invite is
                the same as assigning a role, and the database refuses it for anyone else.
              </Text>
            ) : null}
          </Card>

          <SectionLabel>Unused codes · {openInvites.length}</SectionLabel>

          {openInvites.length === 0 ? <Empty>No outstanding invites.</Empty> : null}

          {openInvites.map((invite) => (
            <Card key={invite.id}>
              <Row style={styles.between}>
                <View style={styles.grow}>
                  <Text style={styles.code} selectable>
                    {invite.code}
                  </Text>
                  <Text style={styles.fine}>
                    {invite.full_name || 'Unnamed'}
                    {invite.email ? ` · ${invite.email}` : ' · any email'}
                  </Text>
                  <Text style={styles.fine}>
                    Expires {new Date(invite.expires_at).toLocaleDateString()}
                  </Text>
                </View>
                <Badge label={invite.role} tone="accent" />
              </Row>
              <Row style={styles.wrap}>
                <Button
                  label="Send it to them"
                  variant="secondary"
                  style={styles.grow}
                  onPress={() => Share.share({ message: inviteMessage(invite.role, invite.code) })}
                />
                <Button label="Revoke" variant="danger" onPress={() => revokeInvite(invite)} />
              </Row>
            </Card>
          ))}

          {expiredInvites.length ? (
            <>
              <SectionLabel>Expired · {expiredInvites.length}</SectionLabel>
              {expiredInvites.map((invite) => (
                <Card key={invite.id}>
                  <Row style={styles.between}>
                    <View style={styles.grow}>
                      <Text style={styles.code} selectable>
                        {invite.code}
                      </Text>
                      <Text style={styles.fine}>
                        {invite.full_name || 'Unnamed'} · expired{' '}
                        {new Date(invite.expires_at).toLocaleDateString()}
                      </Text>
                      <Text style={styles.fine}>
                        Signup refuses it. Invite them again to issue a fresh code.
                      </Text>
                    </View>
                    <Badge label="expired" tone="danger" />
                  </Row>
                </Card>
              ))}
            </>
          ) : null}

          <SectionLabel>Recently used</SectionLabel>
          {usedInvites.length === 0 ? (
            <Empty>Nobody has redeemed an invite yet.</Empty>
          ) : (
            usedInvites.slice(0, 8).map((invite) => (
              <Card key={invite.id}>
                <Row style={styles.between}>
                  <View style={styles.grow}>
                    <Text style={styles.name}>{invite.full_name || invite.code}</Text>
                    <Text style={styles.fine}>
                      Code {invite.code} · used {new Date(invite.used_at!).toLocaleDateString()}
                    </Text>
                    <Text style={styles.fine}>This code cannot be used again.</Text>
                  </View>
                  <Badge label={invite.role} tone="success" />
                </Row>
              </Card>
            ))
          )}
        </>
      ) : (
        <>
          <Field
            label="Search"
            value={search}
            onChangeText={setSearch}
            placeholder="Name, email, or phone"
            autoCapitalize="none"
          />

          {visible.length === 0 ? <Empty>Nobody matches.</Empty> : null}

          {visible.map((person) => {
            const student = students.find((s) => s.student_id === person.id);
            const isEditing = editing === person.id;

            return (
              <Card key={person.id}>
                <Row style={styles.between}>
                  <View style={styles.grow}>
                    <Text style={styles.name}>{person.full_name || '(no name)'}</Text>
                    <Text style={styles.fine}>{person.email}</Text>
                    {person.phone ? <Text style={styles.fine}>{person.phone}</Text> : null}
                    <Text style={styles.fine}>
                      Joined {new Date(person.created_at).toLocaleDateString()}
                    </Text>
                  </View>
                  <View style={styles.right}>
                    <Badge label={person.role} tone="accent" />
                    {person.status !== 'active' ? (
                      <Badge label={person.status} tone="danger" />
                    ) : null}
                  </View>
                </Row>

                {person.role === 'student' && person.status === 'active' ? (
                  isEditing ? (
                    <View style={styles.editor}>
                      <Text style={styles.fine}>Morning hub</Text>
                      <Row style={styles.wrap}>
                        {ref.hubs.map((h) => (
                          <Button
                            key={h.id}
                            label={h.name}
                            variant={student?.morning_hub_id === h.id ? 'primary' : 'secondary'}
                            onPress={() => updateStudent(person.id, { morning_hub_id: h.id })}
                          />
                        ))}
                      </Row>
                      <Text style={styles.fine}>Afternoon hub</Text>
                      <Row style={styles.wrap}>
                        {ref.hubs.map((h) => (
                          <Button
                            key={h.id}
                            label={h.name}
                            variant={student?.afternoon_hub_id === h.id ? 'primary' : 'secondary'}
                            onPress={() => updateStudent(person.id, { afternoon_hub_id: h.id })}
                          />
                        ))}
                      </Row>
                      <Text style={styles.fine}>School</Text>
                      <Row style={styles.wrap}>
                        {ref.schools.map((s) => (
                          <Button
                            key={s.id}
                            label={s.name}
                            variant={student?.school_id === s.id ? 'primary' : 'secondary'}
                            onPress={() => updateStudent(person.id, { school_id: s.id })}
                          />
                        ))}
                      </Row>
                      <Button label="Done" variant="ghost" onPress={() => setEditing(null)} />
                    </View>
                  ) : (
                    <>
                      <Text style={styles.fine}>
                        Hubs: {ref.hubOf(student?.morning_hub_id)?.name ?? 'not set'} (am) ·{' '}
                        {ref.hubOf(student?.afternoon_hub_id)?.name ?? 'not set'} (pm)
                      </Text>
                      <Button
                        label="Set school and hubs"
                        variant="secondary"
                        onPress={() => setEditing(person.id)}
                      />
                    </>
                  )
                ) : null}

                {removing === person.id ? (
                  <View style={styles.removePanel}>
                    <Text style={styles.removeTitle}>Delete this account and all its data?</Text>
                    <Field
                      label="Message they see if they try to sign in again"
                      value={reason}
                      onChangeText={setReason}
                      multiline
                      numberOfLines={3}
                      style={styles.textarea}
                    />
                    <Row>
                      <Button
                        label="Cancel"
                        variant="secondary"
                        onPress={() => setRemoving(null)}
                        style={styles.grow}
                      />
                      <Button
                        label="Remove for good"
                        variant="danger"
                        loading={busyId === person.id}
                        onPress={() => confirmRemove(person)}
                        style={styles.grow}
                      />
                    </Row>
                  </View>
                ) : (
                  <Row style={styles.wrap}>
                    <Button
                      label={person.status === 'active' ? 'Suspend' : 'Reactivate'}
                      variant="secondary"
                      loading={busyId === person.id}
                      onPress={() =>
                        setStatus(person, person.status === 'active' ? 'suspended' : 'active')
                      }
                      style={styles.grow}
                    />
                    <Button
                      label="Remove"
                      variant="danger"
                      onPress={() => {
                        setReason(DEFAULT_REASON);
                        setRemoving(person.id);
                      }}
                    />
                  </Row>
                )}
              </Card>
            );
          })}
        </>
      )}

      <SectionLabel>Administrators</SectionLabel>
      <Card>
        <Text style={styles.fine}>
          Admins are not listed here and cannot be invited from the app — an admin invite has to be
          created in the database. That keeps a compromised admin session from quietly minting
          another one, and it is why the portal password is worth something.
        </Text>
        <Text style={styles.fine}>
          You are {profile?.full_name} ({profile?.role}).
        </Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { gap: 8, paddingVertical: 2 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  chipActive: { borderColor: theme.accent, backgroundColor: theme.surfaceAlt },
  chipText: { color: theme.muted, fontWeight: '600' },
  chipTextActive: { color: theme.accent },
  name: { fontSize: 16, fontWeight: '700', color: theme.text },
  code: { fontSize: 19, fontWeight: '700', color: theme.accent, letterSpacing: 1.5 },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  warn: { fontSize: 12, color: theme.warn, lineHeight: 17 },
  between: { justifyContent: 'space-between' },
  grow: { flex: 1 },
  wrap: { flexWrap: 'wrap' },
  right: { alignItems: 'flex-end', gap: 5 },
  editor: { gap: 8, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 12 },
  removePanel: { gap: 10, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 12 },
  removeTitle: { fontSize: 14, fontWeight: '700', color: theme.danger },
  textarea: { minHeight: 70, textAlignVertical: 'top', paddingTop: 12 },
});
