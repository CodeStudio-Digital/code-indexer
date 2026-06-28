/**
 * A breadcrumb dropped when the user opens Stripe checkout in the system browser.
 * Stripe redirects to the web portal (not back into the desktop app), so the app
 * can't observe the result directly. On the next window focus we consume this flag
 * and reconcile (`billing.sync`) so a paid user is activated immediately — and the
 * "your plan is now active" toast only fires when it followed a real checkout
 * (never on the auto-granted trial). 30-min TTL so a stale flag can't mis-fire.
 */
const KEY = 'mcp-cloud:checkout-pending';
const TTL_MS = 30 * 60_000;

export function markCheckoutPending(): void {
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* storage disabled — the webhook is still the primary activation path */
  }
}

/** True iff a checkout was opened within the TTL. Always clears the flag (one-shot). */
export function consumeCheckoutPending(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    localStorage.removeItem(KEY);
    const ts = Number(raw);
    return Number.isFinite(ts) && Date.now() - ts < TTL_MS;
  } catch {
    return false;
  }
}
