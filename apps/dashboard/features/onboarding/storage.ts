const ONBOARDED_KEY = 'mcp-ide:onboarded';

export function isOnboarded(): boolean {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(ONBOARDED_KEY) === 'true';
}

export function markOnboarded(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ONBOARDED_KEY, 'true');
  } catch {
    /* localStorage full / private mode — onboarding will re-show next session */
  }
}

export function resetOnboarding(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(ONBOARDED_KEY);
  } catch {
    /* best-effort developer helper */
  }
}
