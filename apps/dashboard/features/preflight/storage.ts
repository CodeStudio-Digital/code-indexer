/**
 * First-run preflight "done" flag — per-install UX decision, stored in
 * localStorage exactly like onboarding (`mcp-ide:onboarded`). Uses the NEW
 * `codestudio:` brand prefix since it's a brand-new key (no migration of the
 * shipped `mcp-ide:` keys). The live host checks are always recomputed, so a
 * cleared/forged flag can never hide a genuinely broken environment.
 */
const PREFLIGHT_DONE_KEY = 'codestudio:preflight-done';

export function isPreflightDone(): boolean {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(PREFLIGHT_DONE_KEY) === 'true';
}

export function markPreflightDone(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PREFLIGHT_DONE_KEY, 'true');
  } catch {
    /* private mode / quota — wizard re-shows next session, harmless */
  }
}

export function resetPreflight(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(PREFLIGHT_DONE_KEY);
  } catch {
    /* */
  }
}

/** Preflight is a desktop concern — only gate it when the Electron bridge is live. */
export function isElectronRenderer(): boolean {
  if (typeof window === 'undefined') return false;
  return !!window.electronAPI && typeof window.electronAPI.invoke === 'function';
}
