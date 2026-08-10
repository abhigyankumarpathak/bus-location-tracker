import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Button, Card, theme } from './ui';

/**
 * The driver's QR scanner, for attendance_mode = 'scan'.
 *
 * The DRIVER scans the STUDENT — never the reverse. A code taped inside the van
 * that students scan themselves would be a self-reported boarding, and blueprint
 * §2.1 exists because a child can scan from the pavement and then miss the van.
 * Because the driver's phone does the scanning, the write is a driver write and
 * the safety model is untouched.
 *
 * Stays open between scans. A driver boarding eleven children should not have to
 * reopen the camera eleven times, so this reports each result to the banner at
 * the bottom and keeps looking. `onClose` is the only way out.
 */

export interface ScanFeedback {
  tone: 'success' | 'warn' | 'danger';
  message: string;
}

interface Props {
  visible: boolean;
  onClose(): void;
  /**
   * Called with the raw QR payload. Resolve it to feedback for the banner —
   * returning null means "not one of ours", and the scanner keeps looking
   * without flashing anything at the driver.
   */
  onScan(raw: string): Promise<ScanFeedback | null>;
  /** e.g. "Oak Road — 6 to board". Shown at the top so the driver knows where they are. */
  subtitle?: string;
}

/**
 * The same code re-enters the frame ~30x a second. Ignore a payload we have
 * just handled, and ignore everything while an await is in flight.
 */
const REPEAT_LOCKOUT_MS = 3500;

export function BoardingScanner({ visible, onClose, onScan, subtitle }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);

  const busy = useRef(false);
  const seen = useRef<Map<string, number>>(new Map());

  // A fresh session each time it opens: yesterday's lockouts and last scan's
  // banner are both noise on the next stop.
  useEffect(() => {
    if (visible) {
      seen.current.clear();
      setFeedback(null);
    }
  }, [visible]);

  const handle = useCallback(
    async ({ data }: { data: string }) => {
      if (busy.current) return;

      const now = Date.now();
      const last = seen.current.get(data);
      if (last && now - last < REPEAT_LOCKOUT_MS) return;

      busy.current = true;
      seen.current.set(data, now);

      try {
        const result = await onScan(data);
        if (result) setFeedback(result);
        // A payload that is not ours gets no banner and no lockout — a random
        // QR code in the background should not block a real one behind it.
        else seen.current.delete(data);
      } catch (e) {
        setFeedback({
          tone: 'danger',
          message: e instanceof Error ? e.message : 'That scan did not go through. Try again.',
        });
      } finally {
        busy.current = false;
      }
    },
    [onScan],
  );

  if (!visible) return null;

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        {!permission?.granted ? (
          <View style={styles.centre}>
            <Card style={styles.permCard}>
              <Text style={styles.permTitle}>The camera is not available yet</Text>
              <Text style={styles.permBody}>
                {permission?.canAskAgain === false
                  ? 'Camera access is turned off for this app. Turn it on in your phone settings, or board students by name instead — the buttons on each student still work.'
                  : 'Scanning students on needs the camera. You can also board them by name instead.'}
              </Text>
              {permission?.canAskAgain !== false ? (
                <Button label="Allow camera" onPress={requestPermission} />
              ) : null}
              <Button label="Back to the roster" variant="secondary" onPress={onClose} />
            </Card>
          </View>
        ) : (
          <>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={handle}
            />

            {/* Everything below floats over the camera. */}
            <View style={styles.header} pointerEvents="box-none">
              <Text style={styles.title}>Scan students on</Text>
              {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
            </View>

            <View style={styles.reticle} pointerEvents="none">
              <View style={styles.frame} />
              <Text style={styles.hint}>Point at the code on the student's phone.</Text>
            </View>

            <View style={styles.footer}>
              {feedback ? (
                <View style={[styles.banner, TONE[feedback.tone]]}>
                  <Text style={styles.bannerText}>{feedback.message}</Text>
                </View>
              ) : (
                <View style={[styles.banner, styles.bannerIdle]}>
                  <Text style={styles.bannerIdleText}>Ready — the camera stays on between students.</Text>
                </View>
              )}

              <Pressable onPress={onClose} style={styles.done}>
                <Text style={styles.doneText}>Done scanning</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const TONE = StyleSheet.create({
  success: { backgroundColor: '#14532D', borderColor: theme.success },
  warn: { backgroundColor: '#3F2D12', borderColor: theme.warn },
  danger: { backgroundColor: '#3B1A1A', borderColor: theme.danger },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  centre: { flex: 1, justifyContent: 'center', padding: 20 },
  permCard: { gap: 12 },
  permTitle: { fontSize: 18, fontWeight: '700', color: theme.text },
  permBody: { fontSize: 14, color: theme.muted, lineHeight: 20 },

  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: 64,
    paddingHorizontal: 20,
    paddingBottom: 18,
    backgroundColor: 'rgba(0,0,0,0.55)',
    gap: 2,
  },
  title: { fontSize: 20, fontWeight: '700', color: '#FFF' },
  subtitle: { fontSize: 13, color: '#CBD5E1' },

  reticle: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  frame: {
    width: 236,
    height: 236,
    borderWidth: 3,
    borderColor: '#FFFFFFAA',
    borderRadius: 20,
  },
  hint: { color: '#E2E8F0', fontSize: 14 },

  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 20,
    paddingBottom: 40,
    backgroundColor: 'rgba(0,0,0,0.65)',
    gap: 14,
  },
  banner: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  bannerIdle: { backgroundColor: '#1E293B', borderColor: '#334155' },
  bannerIdleText: { color: '#94A3B8', fontSize: 14 },
  bannerText: { color: '#FFF', fontSize: 15, fontWeight: '600', lineHeight: 21 },

  done: {
    backgroundColor: '#FFF',
    borderRadius: 14,
    paddingVertical: 17,
    alignItems: 'center',
  },
  doneText: { color: '#0F172A', fontSize: 16, fontWeight: '700' },
});
