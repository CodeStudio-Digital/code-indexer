function hostname(value?: string): string | undefined {
  if (!value) return undefined;
  try { return new URL(value.includes('://') ? value : 'https://' + value).hostname.replace(/^api\./, ''); }
  catch { return undefined; }
}

/** The OS vault may select another account when several profiles are connected. */
export function matchesCopilotAccount(
  expected: Record<string, unknown>,
  status: { isAuthenticated: boolean; login?: string; host?: string },
): boolean {
  const { githubLogin, githubHost } = expected;
  if (!status.isAuthenticated || typeof githubLogin !== 'string' || !githubLogin
    || githubLogin.toLowerCase() !== status.login?.toLowerCase()) return false;
  if (typeof githubHost !== 'string' || !githubHost) return true;
  const host = hostname(githubHost);
  return !!host && host === hostname(status.host);
}
