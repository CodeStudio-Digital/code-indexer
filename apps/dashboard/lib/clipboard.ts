/**
 * Copy text to the clipboard with a fallback for non-secure contexts.
 *
 * `navigator.clipboard.writeText` is gated to secure contexts (HTTPS or
 * `localhost`/`127.0.0.1`). Dashboard users that reach the app via a LAN
 * IP (`http://192.168.x.x:port`) silently lose every copy button because
 * the modern API is `undefined` there. The fallback uses a hidden
 * textarea + `document.execCommand('copy')` which still works in plain
 * HTTP.
 *
 * Returns `true` on success, `false` on failure so callers can skip the
 * "Copied!" confirmation state.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy path
    }
  }
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}
