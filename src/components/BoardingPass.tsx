import { StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { encodeBoardingQr } from '../lib/types';
import type { StudentTripStatus } from '../lib/types';
import { Card, theme } from './ui';

/**
 * The student's boarding QR code, for attendance_mode = 'scan'.
 *
 * Shown to the DRIVER, who scans it. It is not a ticket the student scans
 * themselves — see the note in BoardingScanner.tsx for why that distinction is
 * the whole safety model.
 *
 * The code is per trip row, so a student riding both legs has a different one in
 * the morning and the afternoon, and yesterday's screenshot is worthless. It is
 * drawn on a white plate regardless of theme because a camera needs the contrast.
 */

interface Props {
  row: StudentTripStatus;
  /** "Morning — Oak Road" etc, so two codes on one screen are tellable apart. */
  label: string;
}

export function BoardingPass({ row, label }: Props) {
  return (
    <Card style={styles.card}>
      <Text style={styles.label}>{label}</Text>

      <View style={styles.plate}>
        <QRCode value={encodeBoardingQr(row)} size={188} backgroundColor="#FFFFFF" color="#000000" />
      </View>

      <Text style={styles.help}>
        Show this to your driver as you get on. They scan it — that is what marks you on board.
      </Text>
      <Text style={styles.fine}>
        It changes every day, so a screenshot will not work tomorrow.
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { alignItems: 'center', gap: 12 },
  label: { fontSize: 13, fontWeight: '700', color: theme.accent },
  plate: {
    backgroundColor: '#FFFFFF',
    padding: 14,
    borderRadius: 14,
  },
  help: { fontSize: 13, color: theme.text, lineHeight: 19, textAlign: 'center' },
  fine: { fontSize: 11, color: theme.faint, textAlign: 'center' },
});
