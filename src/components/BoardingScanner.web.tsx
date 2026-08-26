import { Modal, StyleSheet, Text, View } from 'react-native';
import { Button, Card, theme } from './ui';

/**
 * The scanner, on WEB.
 *
 * Same reason Map.web.tsx exists: Metro resolves imports at build time, so a
 * runtime Platform check cannot keep a native-only module out of the web bundle.
 *
 * Nobody boards a van from a laptop. The web build exists so a coordinator can
 * work at a desk (§7.3), and a student who happens to be on it is not at a bus
 * stop. So this is not a degraded scanner, it is a signpost — and it names the
 * fallback that always exists, which is the driver boarding them by name.
 */

export interface ScanFeedback {
  tone: 'success' | 'warn' | 'danger';
  message: string;
}

interface Props {
  visible: boolean;
  onClose(): void;
  onScan(raw: string): Promise<ScanFeedback | null>;
  subtitle?: string;
  title?: string;
  hint?: string;
  idle?: string;
  doneLabel?: string;
  deniedBody?: string;
  closeOnSuccess?: boolean;
}

export function BoardingScanner({ visible, onClose }: Props) {
  if (!visible) return null;

  return (
    <Modal visible animationType="fade" onRequestClose={onClose} transparent>
      <View style={styles.backdrop}>
        <Card style={styles.card}>
          <Text style={styles.title}>Scanning happens on the phone app</Text>
          <Text style={styles.body}>
            The browser build cannot open a camera for barcode scanning. Nothing is lost: the
            driver can always board a student by name from their roster, and that records exactly
            the same thing a scan would.
          </Text>
          <Button label="Go back" onPress={onClose} />
        </Card>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  card: { gap: 12, maxWidth: 420 },
  title: { fontSize: 18, fontWeight: '700', color: theme.text },
  body: { fontSize: 14, color: theme.muted, lineHeight: 20 },
});
