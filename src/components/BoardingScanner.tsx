import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Button, Card, theme } from './ui';

/**
 * The QR scanner, for attendance_mode = 'scan'.
 *
 * As of 26 August 2026 this is the STUDENT's camera pointed at the printed card
 * in the van, not the driver's pointed at a phone. The inversion is an operator
 * requirement — minimise what the driver touches — and what it costs is written
 * up on `board_by_vehicle_code()` in supabase/schema.sql. The component itself is
 * direction-agnostic: it turns a QR payload into a verdict somebody can read.
 *
 * Every piece of copy is a prop, because "Scan students on" and "Scan the code in
 * the van" are opposite instructions and hardcoding either was how this ended up
 * needing rewriting the first time.
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
   * without flashing anything at the person holding it.
   */
  onScan(raw: string): Promise<ScanFeedback | null>;
  /** e.g. "Oak Road — 6 to board". Shown under the title. */
  subtitle?: string;
  title?: string;
  /** The line under the reticle: what to physically point the camera at. */
  hint?: string;
  /** The banner before anything has been scanned. */
  idle?: string;
  doneLabel?: string;
  /** What to say when the camera is unavailable, including the way round it. */
  deniedBody?: string;
  /**
   * Close once a scan succeeds. True for a student, who boards once and is done;
   * false for a driver working through a queue of children, who should not have
   * to reopen the camera for each one.
   */
  closeOnSuccess?: boolean;
}

/**
 * The same code re-enters the frame ~30x a second. Ignore a payload we have
 * just handled, and ignore everything while an await is in flight.
 */
const REPEAT_LOCKOUT_MS = 3500;

export function BoardingScanner({
  visible,
  onClose,
  onScan,
  subtitle,
  title = 'Scan',
  hint = 'Point the camera at the code.',
  idle = 'Ready.',
  doneLabel = 'Done scanning',
  deniedBody,
  closeOnSuccess = false,
}: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);

  const busy = useRef(false);
  const seen = useRef<Map<string, number>>(new Map());
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A fresh session each time it opens: yesterday's lockouts and last scan's
  // banner are both noise on the next stop.
  useEffect(() => {
    if (visible) {
      seen.current.clear();
      setFeedback(null);
    }
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      closeTimer.current = null;
    };
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
        if (result) {
          setFeedback(result);
          // Leave the verdict on screen long enough to actually read before the
          // camera disappears — this is the only place a student is told they
          // are aboard.
          if (closeOnSuccess && result.tone === 'success') {
            closeTimer.current = setTimeout(onClose, 2200);
          }
        }
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
    [onScan, closeOnSuccess, onClose],
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
                  ? `Camera access is turned off for this app. Turn it on in your phone settings. ${
                      deniedBody ?? ''
                    }`.trim()
                  : deniedBody ?? 'Scanning needs the camera.'}
              </Text>
              {permission?.canAskAgain !== false ? (
                <Button label="Allow camera" onPress={requestPermission} />
              ) : null}
              <Button label="Go back" variant="secondary" onPress={onClose} />
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
              <Text style={styles.title}>{title}</Text>
              {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
            </View>

            <View style={styles.reticle} pointerEvents="none">
              <View style={styles.frame} />
              <Text style={styles.hint}>{hint}</Text>
            </View>

            <View style={styles.footer}>
              {feedback ? (
                <View style={[styles.banner, TONE[feedback.tone]]}>
                  <Text style={styles.bannerText}>{feedback.message}</Text>
                </View>
              ) : (
                <View style={[styles.banner, styles.bannerIdle]}>
                  <Text style={styles.bannerIdleText}>{idle}</Text>
                </View>
              )}

              <Pressable onPress={onClose} style={styles.done}>
                <Text style={styles.doneText}>{doneLabel}</Text>
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
