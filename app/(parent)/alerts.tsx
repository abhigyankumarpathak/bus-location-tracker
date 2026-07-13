import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { StyleSheet, Text } from 'react-native';
import { useAuth } from '../../src/lib/auth';
import { supabase } from '../../src/lib/supabase';
import { useNotifications } from '../../src/lib/hooks';
import type { Announcement } from '../../src/lib/types';
import {
  Badge,
  Button,
  Card,
  Empty,
  Row,
  Screen,
  SectionLabel,
  Title,
  theme,
} from '../../src/components/ui';

/** Blueprint §4.2: boarding, delay, approaching, route-change and drop-off messages. */
export default function ParentAlerts() {
  const { session } = useAuth();
  const { items, unread, markAllRead } = useNotifications(session?.user.id);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('announcements')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);
    setAnnouncements((data as Announcement[]) ?? []);
  }, []);

  // Tabs stay mounted, so a mount-only fetch never refreshes. Refetch on focus.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const toneFor = (kind: string) => {
    if (kind === 'unable_to_drop_off' || kind === 'no_show' || kind === 'accident') return 'danger';
    if (kind === 'delay' || kind === 'approval') return 'warn';
    if (kind === 'dropped_off' || kind === 'boarded') return 'success';
    return 'accent';
  };

  return (
    <Screen>
      <Row style={styles.between}>
        <Title sub="Everything the school has told you.">Alerts</Title>
        {unread > 0 ? <Button label={`Mark read (${unread})`} variant="ghost" onPress={markAllRead} /> : null}
      </Row>

      {announcements.length > 0 ? (
        <>
          <SectionLabel>From the transport office</SectionLabel>
          {announcements.map((a) => (
            <Card key={a.id}>
              <Text style={styles.title}>{a.title}</Text>
              <Text style={styles.body}>{a.body}</Text>
              <Text style={styles.fine}>{new Date(a.created_at).toLocaleDateString()}</Text>
            </Card>
          ))}
        </>
      ) : null}

      <SectionLabel>Your notifications</SectionLabel>
      {items.length === 0 ? (
        <Empty>
          Nothing yet. Boarding, drop-off, delay, and no-show alerts appear here as they happen.
        </Empty>
      ) : (
        items.map((n) => (
          <Card key={n.id}>
            <Row style={styles.between}>
              <Text style={styles.title}>{n.title}</Text>
              <Badge
                label={n.read_at ? new Date(n.created_at).toLocaleDateString() : 'New'}
                tone={n.read_at ? 'neutral' : toneFor(n.kind)}
              />
            </Row>
            <Text style={styles.body}>{n.body}</Text>
          </Card>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  between: { justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 15, fontWeight: '700', color: theme.text, flexShrink: 1 },
  body: { fontSize: 14, color: theme.muted, lineHeight: 20 },
  fine: { fontSize: 12, color: theme.faint },
});
