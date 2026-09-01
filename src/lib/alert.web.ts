/**
 * `Alert.alert` for the browser — see the note in alert.ts for why this file
 * has to exist at all.
 *
 * Not a degraded fallback. `window.confirm` is modal, keyboard-accessible and
 * impossible to miss, which is precisely what a destructive confirmation wants.
 * Its one real cost is blocking the main thread while open, which for a handful
 * of deliberate confirmations is a fair trade against the previous behaviour of
 * doing nothing whatsoever.
 */

export interface AlertButton {
  text?: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
}

export function alert(title: string, message?: string, buttons?: AlertButton[]) {
  // window.confirm takes one string. The blank line keeps the question legible
  // when the body is a list of names, which several of these are.
  const text = message ? `${title}\n\n${message}` : title;

  const dialogs = typeof window !== 'undefined' && typeof window.confirm === 'function';

  // No buttons, or a single acknowledgement: nothing to decide.
  if (!buttons || buttons.length <= 1) {
    if (dialogs) window.alert(text);
    // Fire it regardless. A one-button alert's handler is the caller continuing
    // its work — swallowing it would reintroduce the exact bug being fixed.
    buttons?.[0]?.onPress?.();
    return;
  }

  // The cancel button is the one marked as such, or failing that the first —
  // React Native's own convention, and every call site in this app follows it.
  const cancel = buttons.find((b) => b.style === 'cancel') ?? buttons[0];
  // The action is the last button that is not cancel. With three buttons that
  // loses the middle option, which no call site here has; if one is ever added,
  // this is where it has to grow a real dialog.
  const action = [...buttons].reverse().find((b) => b !== cancel) ?? buttons[buttons.length - 1];

  // Without dialogs the safe answer is to do nothing and let the person retry,
  // NOT to silently confirm a destructive action nobody agreed to.
  if (!dialogs) {
    cancel.onPress?.();
    return;
  }

  if (window.confirm(text)) action.onPress?.();
  else cancel.onPress?.();
}
