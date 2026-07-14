import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { supabase } from '../lib/supabase';
import { RIDER_STATUS_LABEL, RIDER_STATUS_TONE } from '../lib/types';
import type { WeeklyReport } from '../lib/types';
import { Badge, Card, Empty, Row, SectionLabel, theme } from './ui';

/**
 * The weekly archive, as a family sees it.
 *
 * Every Sunday the system rolls each student's week into one report and sends it
 * to them and their parents — then purges the routine detail behind it. So this
 * is not a convenience view of the trip table; after a few weeks it is the ONLY
 * record of an ordinary ride, which is exactly why it is generated and delivered
 * *before* anything is deleted.
 *
 * Anything that went wrong is not in here alone — incidents, no-shows and
 * coordinator overrides are kept in full, forever.
 */
export function WeeklyReports({
  studentNameFor,
}: {
  /** Parents have several children; students only ever see themselves. */
  studentNameFor?: (studentId: string) => string;
}) {
  const [reports, setReports] = useState<WeeklyReport[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    // RLS scopes this: a student sees their own, a parent sees their linked
    // children's, and nobody sees anyone else's.
    const { data } = await supabase
      .from('weekly_reports')
      .select('*')
      .order('week_start', { ascending: false })
      .limit(20);
    setReports((data as WeeklyReport[]) ?? []);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (reports.length === 0) {
    return (
      <>
        <SectionLabel>Weekly reports</SectionLabel>
        <Empty>
          No reports yet. One arrives at the end of each week, summarising every ride.
        </Empty>
      </>
    );
  }

  return (
    <>
      <SectionLabel>Weekly reports</SectionLabel>

      {reports.map((report) => {
        const t = report.totals ?? {};
        const isOpen = open === report.id;
        const problems = (t.no_show ?? 0) + (t.unable_to_drop_off ?? 0);
        const name = studentNameFor?.(report.student_id);

        return (
          <Card key={report.id}>
            <Pressable onPress={() => setOpen(isOpen ? null : report.id)}>
              <Row style={styles.between}>
                <View style={styles.grow}>
                  <Text style={styles.week}>
                    {name ? `${name} · ` : ''}
                    {formatWeek(report.week_start, report.week_end)}
                  </Text>
                  <Text style={styles.fine}>
                    {t.total ?? 0} ride{(t.total ?? 0) === 1 ? '' : 's'} ·{' '}
                    {t.completed ?? 0} completed
                    {t.absent ? ` · ${t.absent} absent` : ''}
                    {t.parent_pickup ? ` · ${t.parent_pickup} parent pickup` : ''}
                  </Text>
                </View>
                {problems > 0 ? (
                  <Badge label={`${problems} issue${problems === 1 ? '' : 's'}`} tone="danger" />
                ) : (
                  <Badge label="All good" tone="success" />
                )}
              </Row>
            </Pressable>

            {isOpen ? (
              <View style={styles.rides}>
                {(report.rides ?? []).map((ride, i) => (
                  <View key={`${ride.date}-${i}`} style={styles.ride}>
                    <Row style={styles.between}>
                      <View style={styles.grow}>
                        <Text style={styles.rideDate}>
                          {new Date(ride.date).toLocaleDateString(undefined, {
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                          })}
                          {' · '}
                          {ride.route}
                        </Text>
                        <Text style={styles.fine}>
                          {ride.hub ?? 'No hub'}
                          {ride.boarded ? ` · boarded ${time(ride.boarded)}` : ''}
                          {ride.dropped_off ? ` · dropped ${time(ride.dropped_off)}` : ''}
                        </Text>
                        {/* Who actually drove, and in which van — including a
                            substitute. The trip row itself is purged for an
                            ordinary day, so this is the only place it survives. */}
                        <Text style={styles.fine}>
                          {ride.driver ? `Driver: ${ride.driver}` : 'Driver not recorded'}
                          {ride.vehicle ? ` · ${ride.vehicle}` : ''}
                        </Text>
                        {ride.note ? <Text style={styles.note}>{ride.note}</Text> : null}
                      </View>
                      <Badge
                        label={RIDER_STATUS_LABEL[ride.status]}
                        tone={RIDER_STATUS_TONE[ride.status]}
                      />
                    </Row>
                  </View>
                ))}
                <Text style={styles.fine}>
                  Generated {new Date(report.generated_at).toLocaleDateString()}. This is the
                  permanent record of the week — the day-to-day detail behind it is cleared to keep
                  the system small.
                </Text>
              </View>
            ) : (
              <Text style={styles.tap}>Tap to see every ride ›</Text>
            )}
          </Card>
        );
      })}
    </>
  );
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function formatWeek(start: string, end: string) {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  return `${new Date(start).toLocaleDateString(undefined, opts)} – ${new Date(
    end,
  ).toLocaleDateString(undefined, opts)}`;
}

const styles = StyleSheet.create({
  between: { justifyContent: 'space-between' },
  grow: { flex: 1 },
  week: { fontSize: 15, fontWeight: '700', color: theme.text },
  fine: { fontSize: 12, color: theme.faint, lineHeight: 17 },
  note: { fontSize: 12, color: theme.warn, lineHeight: 17 },
  tap: { fontSize: 12, color: theme.accent, fontWeight: '600' },
  rides: { gap: 8, borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 10 },
  ride: {
    padding: 10,
    borderRadius: 10,
    backgroundColor: theme.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.border,
  },
  rideDate: { fontSize: 13, fontWeight: '700', color: theme.text },
});
