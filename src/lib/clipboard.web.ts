/**
 * Copy, in a browser.
 *
 * `navigator.clipboard` needs no native module and no rebuild, which is why web
 * gets a real copy while native falls back to the share sheet — see the note in
 * clipboard.ts.
 *
 * Two things make it fail, and both are silent unless handled:
 *
 *   1. It requires a SECURE CONTEXT. Over plain http the API is not there at
 *      all — not denied, absent.
 *   2. It requires recent USER ACTIVATION. Copying after an await, which is the
 *      only option when the text is a code the server just generated, can land
 *      outside that window in stricter browsers.
 *
 * So there is a fallback, and a caller that reports what really happened. The
 * old execCommand path is deprecated everywhere and works anyway, which is
 * exactly what a fallback is for.
 */
export type CopyResult = 'copied' | 'shared' | 'failed';

export async function copyText(text: string): Promise<CopyResult> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch {
      // Fall through — usually a lapsed user-activation window.
    }
  }

  // A hidden textarea and the deprecated command. Ugly, synchronous, and it
  // works where the modern API has just refused.
  try {
    if (typeof document === 'undefined') return 'failed';

    const area = document.createElement('textarea');
    area.value = text;
    // Off-screen rather than display:none — a hidden element cannot be selected.
    area.style.position = 'fixed';
    area.style.top = '-9999px';
    area.setAttribute('readonly', '');
    document.body.appendChild(area);
    area.select();

    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok ? 'copied' : 'failed';
  } catch {
    return 'failed';
  }
}
