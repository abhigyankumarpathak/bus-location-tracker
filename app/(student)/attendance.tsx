import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../src/lib/auth';
import { useFeatures } from '../../src/lib/org';
import { useToday } from '../../src/lib/org';
import { supabase } from '../../src/lib/supabase';
import { ABSENCE_LABEL, decodeVanQr } from '../../src/lib/types';
import type {
  Attendance,
  AttendanceAbsence,
  AttendanceResult,
  AbsenceKind,
  MonitorRosterRow,
} from '../../src/lib/types';
import { BoardingScanner } from '../../src/components/BoardingScanner';
import { FamilyLinks } from '../../src/components/FamilyLinks';
import type { ScanFeedback } from '../../src/components/BoardingScanner';
import {
  Button,
  Card,
  ErrorText,
  Field,
  Loading,
  Row,
  Screen,
  SectionLabel,
  Title,
  theme,
} from '../../src/components/ui';
import { alert } from '../../src/lib/alert';

/**
 * The student's whole app in attendance-only mode.
 *
 * There is no check-in here, no hub, no van and no timeline — because in this
 * mode none of those exist. One question, one action, one answer.
 *
 * WHAT A MARK MEANS, AND WHAT IT DOES NOT. It means this student presented the
 * school's code at a door, after the evening cutoff. It does not mean anybody
 * saw them board anything. No wording on this screen may imply otherwise; that
 * is the same rule the rest of the app follows about the difference between a
 * claim and a confirmation, and it matters more here because there is no driver
 * to do the confirming.
 */
export default function StudentAttendance() {
  const { session, profile, signOut } = useAuth();
  const { attendanceOpensAt } = useFeatures();
  const today = useToday();
  const me = session?.user.id;

  const [mark, setMark] = useState<Attendance | null>(null);
  const [away, setAway] = useState<AttendanceAbsence | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');

  /** Telling the school you are not riding, and why. */
  const [declaring, setDeclaring] = useState(false);
  const [kind, setKind] = useState<AbsenceKind>('club');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  /**
   * The riders this student has to account for, if they are a bus monitor.
   * Empty for everybody else, so the section simply does not render.
   */
  const [roster, setRoster] = useState<MonitorRosterRow[]>([]);
  /** Who the monitor is about to confirm. Everyone, until they say otherwise. */
  const [absentees, setAbsentees] = useState<string[]>([]);

  const reload = useCallback(async () => {
    if (!me) return;
    const { data } = await supabase
      .from('attendance')
      .select('*')
      .eq('student_id', me)
      .eq('on_date', today)
      .maybeSingle();
    setMark((data as Attendance) ?? null);

    // The span covering today, if there is one. Filtered client-side because a
    // student has at most a handful of these and the query is simpler read.
    const { data: spans } = await supabase
      .from('attendance_absence')
      .select('*')
      .eq('student_id', me)
      .is('cancelled_at', null)
      .lte('on_date', today);
    const covering =
      ((spans as AttendanceAbsence[]) ?? []).find(
        (a) => (a.end_date ?? a.on_date) >= today,
      ) ?? null;
    setAway(covering);

    // Returns nothing at all unless this student is a monitor, so it costs one
    // round trip and renders nothing for the other ninety-nine per cent.
    const { data: mine } = await supabase.rpc('my_monitor_roster');
    setRoster((mine as MonitorRosterRow[]) ?? []);

    setLoading(false);
  }, [me, today]);

  /** Confirm everyone still ticked. Anyone toggled off is left unmarked. */
  async function confirmRoster() {
    const targets = roster
      .filter((r) => !r.present && !absentees.includes(r.student_id))
      .map((r) => r.student_id);
    if (!targets.length) return;

    setBusy(true);
    const { data, error: e } = await supabase.rpc('monitor_mark', { targets });
    setBusy(false);
    if (e) return setError(e.message);

    const res = data as { ok: boolean; marked?: number; message?: string };
    if (!res?.ok) return setError(res?.message ?? 'That did not save.');

    setAbsentees([]);
    await reload();
    alert(
      'Thank you',
      `${res.marked} ${res.marked === 1 ? 'rider' : 'riders'} confirmed aboard. Anyone you left off stays unmarked, and the office will see them.`,
    );
  }

  async function declare() {
    if (!me) return;
    setError('');
    setBusy(true);
    const { data, error: e } = await supabase.rpc('declare_absence', {
      target: me,
      from_date: today,
      to_date: null,
      kind,
      reason: reason.trim() || null,
    });
    setBusy(false);
    if (e) return setError(e.message);

    const res = data as { ok: boolean; message?: string };
    if (!res?.ok) return setError(res?.message ?? 'That did not save.');

    setDeclaring(false);
    setReason('');
    await reload();
    alert(
      'Told the school',
      'Your family has been told too. If it turns out you are riding after all, just scan the code — that works and they will be told again.',
    );
  }

  async function undeclare() {
    if (!away) return;
    setBusy(true);
    const { error: e } = await supabase.rpc('cancel_absence', { absence_id: away.id });
    setBusy(false);
    if (e) return setError(e.message);
    await reload();
  }

  useEffect(() => {
    reload();
  }, [reload]);

  /**
   * The evening lock, on the client.
   *
   * Duplicated from mark_attendance(), which is where it is actually enforced —
   * this copy exists so the button can explain the rule BEFORE the camera opens,
   * rather than sending a student out to a doorway to be refused. If the rule
   * changes it changes in both places.
   */
  const opensAt = (() => {
    const [h, m] = attendanceOpensAt.split(':').map(Number);
    const at = new Date();
    at.setHours(h || 0, m || 0, 0, 0);
    return at;
  })();
  const tooEarly = new Date() < opensAt;
  const opensLabel = opensAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const resolveScan = useCallback(
    async (raw: string): Promise<ScanFeedback | null> => {
      // Same payload shape as the van card, so one printed format covers both
      // modes and a scanner pointed at the wrong one still resolves.
      const code = decodeVanQr(raw) ?? raw.trim();
      if (!code) return null;

      const { data, error: e } = await supabase.rpc('mark_attendance', { code });
      if (e) return { tone: 'danger', message: e.message };

      const verdict = data as AttendanceResult | null;
      if (!verdict) return { tone: 'danger', message: 'That did not go through. Try again.' };

      await reload();
      return { tone: verdict.tone, message: verdict.message };
    },
    [reload],
  );

  if (loading) return <Loading />;

  return (
    <Screen>
      <Title sub={profile?.full_name || undefined}>Attendance</Title>

      {mark ? (
        <Card style={styles.done}>
          <Text style={styles.doneTitle}>✓ Marked attended</Text>
          <Text style={styles.doneBody}>
            Recorded at{' '}
            {new Date(mark.marked_at).toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit',
            })}
            {mark.source === 'staff' ? ', by the office' : ''}.
          </Text>
          <Text style={styles.fine}>Nothing more to do today.</Text>
        </Card>
      ) : tooEarly ? (
        <Card style={styles.locked}>
          <Text style={styles.lockedTitle}>This is only for evenings</Text>
          <Text style={styles.doneBody}>
            Attendance opens at {opensLabel}. Come back then and scan the code.
          </Text>
        </Card>
      ) : (
        <Card>
          <Text style={styles.prompt}>Scan the code to mark attendance</Text>
          <Button label="Scan QR code" onPress={() => setScanning(true)} />
          <Text style={styles.fine}>
            The code is on a card at the door. Scanning it records that you were here this
            evening.
          </Text>
        </Card>
      )}

      {/*
        Telling the school you are NOT riding.
        Shown even when already marked away, so it can be taken back — and shown
        even after scanning, because the only thing that would achieve then is
        confusion, so it is not.
      */}
      {!mark ? (
        <>
          <SectionLabel>Not riding today?</SectionLabel>

          {away ? (
            <Card style={styles.away}>
              <Text style={styles.awayTitle}>
                {ABSENCE_LABEL[away.kind]}
                {(away.end_date ?? away.on_date) !== away.on_date ? ' (several days)' : ''}
              </Text>
              <Text style={styles.doneBody}>
                {away.source === 'student'
                  ? 'You told the school you are not on the bus. Your family has been told.'
                  : away.source === 'parent'
                    ? 'Your family told the school you are not on the bus.'
                    : 'The office has marked you as not riding.'}
                {away.reason ? ` Reason: ${away.reason}` : ''}
              </Text>
              <Text style={styles.fine}>
                If the club is cancelled and you do ride, just scan the code — that still works,
                and your family will be told you are on the bus after all.
              </Text>
              <Button
                label="Actually, I am riding"
                variant="secondary"
                loading={busy}
                onPress={undeclare}
              />
            </Card>
          ) : declaring ? (
            <Card>
              <Text style={styles.prompt}>Why not?</Text>
              <Row style={styles.wrap}>
                <Button
                  label="Staying for a club"
                  variant={kind === 'club' ? 'primary' : 'secondary'}
                  onPress={() => setKind('club')}
                />
                <Button
                  label="Not riding"
                  variant={kind === 'absent' ? 'primary' : 'secondary'}
                  onPress={() => setKind('absent')}
                />
              </Row>
              <Field
                label="Anything to add? (optional)"
                value={reason}
                onChangeText={setReason}
                placeholder="Chess club until 5."
              />
              <Row style={styles.wrap}>
                <Button label="Tell the school" loading={busy} onPress={declare} />
                <Button label="Cancel" variant="ghost" onPress={() => setDeclaring(false)} />
              </Row>
              <Text style={styles.fine}>
                Your parents are told as well — they should not find out from an empty seat.
              </Text>
            </Card>
          ) : (
            <Card>
              <Button
                label="I won't be on the bus"
                variant="secondary"
                onPress={() => setDeclaring(true)}
              />
              <Text style={styles.fine}>
                Staying for a club, or getting home another way? Tell the school so nobody is
                looking for you.
              </Text>
            </Card>
          )}
        </>
      ) : null}

      <ErrorText>{error}</ErrorText>

      {/*
        THE MONITOR'S JOB. Renders only for a monitor, because my_monitor_roster()
        returns nothing for anyone else.

        Everyone is ticked by default and the button confirms the ticked ones —
        rather than one blanket "everybody is here", which is the mistake the
        full app already fixed on its batch drop-off: a single tap covering
        thirty children trains the tap, and a trained tap means nothing. Marking
        the exception first is what keeps the rest of it worth something.

        Nobody expected away appears here at all; the server filters them out, so
        a monitor is never asked about a child whose parents already said they
        were not coming.
      */}
      {roster.length > 0 ? (
        <>
          <SectionLabel>Riders without a phone ({roster.length})</SectionLabel>
          <Card style={styles.monitor}>
            <Text style={styles.prompt}>You are a bus monitor</Text>
            <Text style={styles.fine}>
              These riders cannot scan for themselves. Check they are on the bus, then confirm.
              Tap anyone who is NOT here to leave them off.
            </Text>

            {roster.map((r) => {
              const off = absentees.includes(r.student_id);
              return (
                <Row key={r.student_id} style={styles.between}>
                  <View style={styles.grow}>
                    <Text style={r.present || !off ? styles.riderName : styles.riderOff}>
                      {r.student_name}
                    </Text>
                    {r.present ? (
                      <Text style={styles.fine}>
                        Already marked
                        {r.marked_at
                          ? ` at ${new Date(r.marked_at).toLocaleTimeString([], {
                              hour: 'numeric',
                              minute: '2-digit',
                            })}`
                          : ''}
                        .
                      </Text>
                    ) : off ? (
                      <Text style={styles.fine}>Not here — will be left unmarked.</Text>
                    ) : null}
                  </View>
                  {r.present ? (
                    <Text style={styles.tick}>✓</Text>
                  ) : (
                    <Button
                      label={off ? 'Actually here' : 'Not here'}
                      variant="ghost"
                      onPress={() =>
                        setAbsentees((prev) =>
                          off ? prev.filter((x) => x !== r.student_id) : [...prev, r.student_id],
                        )
                      }
                    />
                  )}
                </Row>
              );
            })}

            {roster.some((r) => !r.present) ? (
              <Button
                label={
                  absentees.length
                    ? `Confirm the other ${roster.filter((r) => !r.present && !absentees.includes(r.student_id)).length} are here`
                    : 'Everyone without a phone is here'
                }
                loading={busy}
                onPress={confirmRoster}
              />
            ) : (
              <Text style={styles.doneBody}>✓ All of your riders are accounted for.</Text>
            )}
          </Card>
        </>
      ) : null}

      {/*
        LINKING A PARENT. This lives on the Profile tab normally, which this mode
        hides — and the link policy requires the OTHER party to accept, so a
        parent who proposed one had nobody able to say yes. The flow was
        one-way-broken with no visible cause.
      */}
      <SectionLabel>Family</SectionLabel>
      <FamilyLinks perspective="student" />

      {/*
        Attendance-only mode hides every other student tab, and Sign out lived on
        the Profile tab — so a student had no way out of their own account. The
        parent side keeps its More tab for exactly this reason; the student side
        has no equivalent, so the button belongs here.
      */}
      <SectionLabel>Account</SectionLabel>
      <Button label="Sign out" variant="secondary" onPress={signOut} />

      <BoardingScanner
        visible={scanning}
        onClose={() => {
          setScanning(false);
          reload();
        }}
        onScan={resolveScan}
        title="Mark attendance"
        subtitle="The code is on the card at the door"
        hint="Point the camera at the code."
        idle="Find the code and point the camera at it."
        doneLabel="Close"
        deniedBody="Without the camera you cannot scan yourself in — ask a member of staff to mark you."
        closeOnSuccess
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  done: { borderColor: theme.success, gap: 8 },
  doneTitle: { fontSize: 22, fontWeight: '700', color: theme.success },
  doneBody: { fontSize: 15, color: theme.text, lineHeight: 21 },
  locked: { borderColor: theme.warn, gap: 8 },
  lockedTitle: { fontSize: 20, fontWeight: '700', color: theme.warn },
  prompt: { fontSize: 18, fontWeight: '700', color: theme.text, marginBottom: 4 },
  wrap: { flexWrap: 'wrap' },
  away: { borderColor: theme.accent, gap: 8 },
  awayTitle: { fontSize: 18, fontWeight: '700', color: theme.accent },
  monitor: { borderColor: theme.warn, gap: 10 },
  between: { justifyContent: 'space-between' },
  grow: { flex: 1 },
  riderName: { fontSize: 16, fontWeight: '600', color: theme.text },
  riderOff: { fontSize: 16, fontWeight: '600', color: theme.faint, textDecorationLine: 'line-through' },
  tick: { fontSize: 20, color: theme.success },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
});
