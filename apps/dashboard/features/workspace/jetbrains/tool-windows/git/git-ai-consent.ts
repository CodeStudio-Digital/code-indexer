const GIT_AI_DIFF_CONSENT_KEY = 'mcp:git:ai-diff-consent';

export function readGitAiDiffConsent(storage?: Pick<Storage, 'getItem'>): boolean {
  try {
    const target = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
    return target?.getItem(GIT_AI_DIFF_CONSENT_KEY) === 'granted';
  } catch {
    return false;
  }
}

export function writeGitAiDiffConsent(
  granted: boolean,
  storage?: Pick<Storage, 'setItem'>,
): void {
  try {
    const target = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
    target?.setItem(GIT_AI_DIFF_CONSENT_KEY, granted ? 'granted' : 'denied');
  } catch {
    // Private browsing / a full quota must not break the commit surface.
  }
}
