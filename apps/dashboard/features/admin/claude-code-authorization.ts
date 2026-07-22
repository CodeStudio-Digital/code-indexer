export interface ClaudeCodeAuthorizationUrls {
  authorizeUrl: string;
  manualAuthorizeUrl?: string;
}

export interface ClaudeCodeAuthorizationOpeners {
  openExternal?: (url: string) => void;
  openWindow: (url: string) => void;
}

export type ClaudeCodeAuthorizationMode = 'automatic' | 'manual';

/**
 * Opens the selected Claude Code authorization without changing its PKCE flow.
 * In particular, retrying after a Claude login must reuse the automatic URL;
 * the manual redirect is only for the explicit code-paste fallback.
 */
export function openClaudeCodeAuthorization(
  urls: ClaudeCodeAuthorizationUrls,
  mode: ClaudeCodeAuthorizationMode,
  openers: ClaudeCodeAuthorizationOpeners,
): boolean {
  const url = mode === 'manual' ? urls.manualAuthorizeUrl : urls.authorizeUrl;
  if (!url) return false;

  if (openers.openExternal) openers.openExternal(url);
  else openers.openWindow(url);
  return true;
}
