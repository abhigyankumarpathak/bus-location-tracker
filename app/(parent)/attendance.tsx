import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../src/lib/auth';
import { useFeatures, useToday } from '../../src/lib/org';
import { supabase } from '../../src/lib/supabase';
import { useMyChildren } from '../../src/lib/hooks';
import { ABSENCE_LABEL, formatDateSpan } from '../../src/lib/types';
import type { Attendance, AttendanceAbsence, AbsenceKind } from '../../src/lib/types';
import { alert } from '../../src/lib/alert';
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
 * What a parent sees in attendance-only mode: did my child board this evening?
 *
 * Today only. The history is its own tab, because a parent opening this at six
 * o'clock wants one word, and a list of the last three weeks buries it.
 *
 * THE WORDING IS THE FEATURE. A missing row is the absence of a scan, not a
 * statement that the child was away — so it reads "Not marked", never "Absent".
 * The app genuinely does not know which, and saying so is the only honest
 * option: nobody confirmed anything, there is no driver in this mode to do it.
 */
export default function ParentAttendance() {
  const { signOut } = useAuth();
  const { children, loading: childrenLoading } = useMyChildren();
  const { attendanceOpensAt } = useFeatures();
  const today = useToday();

  const [marks, setMarks] = useState<Attendance[]>([]);
  const [absences, setAbsences] = useState<AttendanceAbsence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  /** Declaring one: which child, which days, why. */
  const [forChild, setForChild] = useState<string | null>(null);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState('');
  const [multiDay, setMultiDay] = useState(false);
  const [kind, setKind] = useState<AbsenceKind>('absent');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!children.length) {
      setMarks([]);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from('attendance')
      .select('*')
      .eq('on_date', today)
      .in('student_id', children.map((c) => c.id));
    setMarks((data as Attendance[]) ?? []);

    const { data: abs } = await supabase
      .from('attendance_absence')
      .select('*')
      .is('cancelled_at', null)
      .in('student_id', children.map((c) => c.id))
      .order('on_date', { ascending: true });
    setAbsences((abs as AttendanceAbsence[]) ?? []);

    setLoading(false);
  }, [children, today]);

  /** The span covering `day`, if any. */
  const awayOn = (studentId: string, day: string) =>
    absences.find(
      (a) => a.student_id === studentId && a.on_date <= day && (a.end_date ?? a.on_date) >= day,
    ) ?? null;

  async function declare() {
    if (!forChild) return;
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    if (!iso.test(from)) return setError('Enter the first date as YYYY-MM-DD.');
    if (multiDay && !iso.test(to)) return setError('Enter the last date as YYYY-MM-DD.');
    if (multiDay && to < from) return setError('The last day cannot be before the first.');

    setError('');
    setBusy(true);
    const { data, error: e } = await supabase.rpc('declare_absence', {
      target: forChild,
      from_date: from,
      to_date: multiDay ? to : null,
      kind,
      reason: reason.trim() || null,
    });
    setBusy(false);
    if (e) return setError(e.message);

    const res = data as { ok: boolean; message?: string };
    if (!res?.ok) return setError(res?.message ?? 'That did not save.');

    setForChild(null);
    setReason('');
    setMultiDay(false);
    setTo('');
    await reload();
    alert('Saved', 'The school knows, and so does your child.');
  }

  async function cancel(id: string) {
    setBusy(true);
    const { error: e } = await supabase.rpc('cancel_absence', { absence_id: id });
    setBusy(false);
    if (e) return setError(e.message);
    await reload();
  }

  useEffect(() => {
    reload();
  }, [reload]);

  if (childrenLoading || loading) return <Loading />;

  if (!children.length) {
    return (
      <Screen>
        <Title sub="Link a child and their attendance appears here.">Attendance</Title>
        <Empty>No children linked to this account yet.</Empty>
      </Screen>
    );
  }

  return (
    <Screen>
      <Title sub={new Date(`${today}T12:00:00`).toLocaleDateString([], {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      })}>
        Attendance
      </Title>

      {children.map((child) => {
        const mark = marks.find((m) => m.student_id === child.id) ?? null;
        const away = awayOn(child.id, today);

        return (
          <Card
            key={child.id}
            style={mark ? styles.present : away ? styles.awayCard : styles.absent}
          >
            <Row style={styles.between}>
              <Text style={styles.name}>{child.full_name}</Text>
              <Badge
                label={mark ? 'Boarded' : away ? 'Not riding' : 'Not marked'}
                tone={mark ? 'success' : away ? 'accent' : 'neutral'}
              />
            </Row>

            {/*
              THE NOTICE. A child telling the school something the family has not
              heard is the gap this whole screen exists to close, so it is stated
              here and not left to a push notification that may have been swiped
              away.
            */}
            {away && away.source === 'student' ? (
              <Text style={styles.notice}>
                {child.full_name.split(' ')[0]} told the school{' '}
                {away.kind === 'club'
                  ? 'they are staying for a club'
                  : 'they will not be riding'}
                {away.reason ? ` — “${away.reason}”` : ''}. You did not tell us this; they did.
              </Text>
            ) : null}

            {mark ? (
              <Text style={styles.body}>
                Boarded in the evening, recorded at{' '}
                {new Date(mark.marked_at).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
                {mark.source === 'staff' ? ' by the office' : ''}.
                {away ? ' They were down as not riding, and rode anyway.' : ''}
              </Text>
            ) : away ? (
              <>
                <Text style={styles.body}>
                  Not expected on the bus — {ABSENCE_LABEL[away.kind].toLowerCase()},{' '}
                  {formatDateSpan(away.on_date, away.end_date)}.
                </Text>
                <Text style={styles.fine}>
                  Nobody is looking for them. If they ride after all they can still scan on, and
                  you will be told.
                </Text>
                <Button
                  label="Cancel this — they are riding"
                  variant="ghost"
                  loading={busy}
                  onPress={() => cancel(away.id)}
                />
              </>
            ) : (
              <>
                <Text style={styles.body}>Not boarded this evening.</Text>
                <Text style={styles.fine}>
                  Attendance opens at{' '}
                  {(() => {
                    const [h, m] = attendanceOpensAt.split(':').map(Number);
                    const at = new Date();
                    at.setHours(h || 0, m || 0, 0, 0);
                    return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                  })()}
                  . Nothing has been recorded — which means nobody scanned, not that anyone has
                  said your child is away.
                </Text>
              </>
            )}
          </Card>
        );
      })}

      <ErrorText>{error}</ErrorText>

      <SectionLabel>Account</SectionLabel>
      <Button label="Sign out" variant="secondary" onPress={signOut} />

      <SectionLabel>Tell the school about days off</SectionLabel>
      {forChild ? (
        <Card>
          <Text style={styles.name}>
            {children.find((c) => c.id === forChild)?.full_name}
          </Text>
          <Row style={styles.wrap}>
            <Button
              label={multiDay ? 'Several days' : 'One day'}
              variant="secondary"
              onPress={() => {
                const next = !multiDay;
                setMultiDay(next);
                if (next && !to) setTo(from);
              }}
            />
          </Row>
          <Field
            label={multiDay ? 'First day away' : 'Date'}
            value={from}
            onChangeText={setFrom}
            placeholder="YYYY-MM-DD"
            autoCapitalize="none"
          />
          {multiDay ? (
            <>
              <Field
                label="Last day away"
                value={to}
                onChangeText={setTo}
                placeholder="YYYY-MM-DD"
                autoCapitalize="none"
              />
              <Text style={styles.fine}>
                {/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && to >= from
                  ? `${formatDateSpan(from, to)} — one entry covers all of it, weekends included.`
                  : 'Enter both dates as YYYY-MM-DD.'}
              </Text>
            </>
          ) : null}
          <Row style={styles.wrap}>
            <Button
              label="Not riding"
              variant={kind === 'absent' ? 'primary' : 'secondary'}
              onPress={() => setKind('absent')}
            />
            <Button
              label="Staying for a club"
              variant={kind === 'club' ? 'primary' : 'secondary'}
              onPress={() => setKind('club')}
            />
          </Row>
          <Field
            label="Reason (optional)"
            value={reason}
            onChangeText={setReason}
            placeholder="Away with family."
          />
          <Row style={styles.wrap}>
            <Button label="Save" loading={busy} onPress={declare} />
            <Button label="Cancel" variant="ghost" onPress={() => setForChild(null)} />
          </Row>
        </Card>
      ) : (
        <Card>
          <Text style={styles.fine}>
            Pick a child and the days they will not be on the bus. They are told as well, and the
            office stops expecting them.
          </Text>
          <Row style={styles.wrap}>
            {children.map((c) => (
              <Button
                key={c.id}
                label={c.full_name}
                variant="secondary"
                onPress={() => {
                  setForChild(c.id);
                  setFrom(today);
                  setKind('absent');
                }}
              />
            ))}
          </Row>
        </Card>
      )}

      {/* Anything already declared for a future day. Today's is on the card above. */}
      {absences.filter((a) => a.on_date > today).length > 0 ? (
        <>
          <SectionLabel>Coming up</SectionLabel>
          {absences
            .filter((a) => a.on_date > today)
            .map((a) => (
              <Card key={a.id}>
                <Row style={styles.between}>
                  <View style={styles.grow}>
                    <Text style={styles.name}>
                      {children.find((c) => c.id === a.student_id)?.full_name ?? 'Student'}
                    </Text>
                    <Text style={styles.fine}>
                      {ABSENCE_LABEL[a.kind]} · {formatDateSpan(a.on_date, a.end_date)}
                      {a.source === 'student' ? ' · they told us' : ''}
                      {a.reason ? ` · ${a.reason}` : ''}
                    </Text>
                  </View>
                </Row>
                <Button
                  label="Cancel"
                  variant="ghost"
                  loading={busy}
                  onPress={() => cancel(a.id)}
                />
              </Card>
            ))}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  between: { justifyContent: 'space-between' },
  present: { borderColor: theme.success, gap: 8 },
  awayCard: { borderColor: theme.accent, gap: 8 },
  grow: { flex: 1 },
  wrap: { flexWrap: 'wrap' },
  notice: {
    fontSize: 13,
    color: theme.accent,
    lineHeight: 19,
    fontWeight: '600',
  },
  absent: { gap: 8 },
  name: { fontSize: 18, fontWeight: '700', color: theme.text, flexShrink: 1 },
  body: { fontSize: 15, color: theme.text, lineHeight: 21 },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
});
