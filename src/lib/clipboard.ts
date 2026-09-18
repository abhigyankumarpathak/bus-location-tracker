import { Share } from 'react-native';

/**
 * Put text where somebody can paste it.
 *
 * NATIVE has no clipboard here on purpose. `expo-clipboard` is a native module,
 * and adding one forces a full rebuild of the phone apps for something the OS
 * share sheet already does better — sharing offers Copy alongside Messages,
 * Mail and everything else a coordinator actually uses to reach a parent.
 *
 * There is a `clipboard.web.ts` sibling. The browser's own clipboard API needs
 * no dependency at all, so web gets a real copy and the native build is
 * untouched — which is the whole reason this is a two-file split rather than a
 * runtime check.
 *
 * Returns what actually happened, because the caller has to tell the truth
 * about it: "Copied" over a share sheet that was dismissed is a small lie that
 * costs somebody a lost invite code.
 */
export type CopyResult = 'copied' | 'shared' | 'failed';

export async function copyText(text: string): Promise<CopyResult> {
  try {
    await Share.share({ message: text });
    return 'shared';
  } catch {
    return 'failed';
  }
}
