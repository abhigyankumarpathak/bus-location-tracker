import { Alert } from 'react-native';

/**
 * `Alert.alert`, but it also works in a browser.
 *
 * react-native-web's implementation is, verbatim:
 *
 *     class Alert { static alert() {} }
 *
 * An empty function. It does not warn and it does not fall back — so on the web
 * build every confirmation in this app silently did not happen. The visible
 * symptom was switches that would not move and buttons that seemed dead,
 * because the real work sat inside an `onPress` that was never called.
 *
 * Bad anywhere; dangerous here. "Leave anyway", "Unable to drop off" and the
 * batch drop-off confirm are destructive actions deliberately placed behind a
 * dialog, and a coordinator working at a desk — the browser is where §7.3 says
 * they belong — could not complete any of them.
 *
 * SAME SIGNATURE AS `Alert.alert` ON PURPOSE. Call sites differ from the
 * original by one token, which is what made replacing thirty-four of them a
 * mechanical change rather than thirty-four chances to introduce a bug.
 */

export interface AlertButton {
  text?: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
}

export function alert(title: string, message?: string, buttons?: AlertButton[]) {
  Alert.alert(title, message, buttons);
}
