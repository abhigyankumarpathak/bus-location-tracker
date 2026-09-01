import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../src/lib/auth';
import { useFeatures } from '../../src/lib/org';
import { useToday } from '../../src/lib/org';
import { supabase } from '../../src/lib/supabase';
import { decodeVanQr } from '../../src/lib/types';
import type { Attendance, AttendanceResult } from '../../src/lib/types';
import { BoardingScanner } from '../../src/components/BoardingScanner';
import type { ScanFeedback } from '../../src/components/BoardingScanner';
import {
  Button,
  Card,
  ErrorText,
  Loading,
  Screen,
  Title,
  theme,
} from '../../src/components/ui';

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
  const { session, profile } = useAuth();
  const { attendanceOpensAt } = useFeatures();
  const today = useToday();
  const me = session?.user.id;

  const [mark, setMark] = useState<Attendance | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!me) return;
    const { data } = await supabase
      .from('attendance')
      .select('*')
      .eq('student_id', me)
      .eq('on_date', today)
      .maybeSingle();
    setMark((data as Attendance) ?? null);
    setLoading(false);
  }, [me, today]);

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

      <ErrorText>{error}</ErrorText>

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
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
});
