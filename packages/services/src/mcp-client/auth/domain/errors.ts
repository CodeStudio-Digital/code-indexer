/**
 * Discriminated union of domain errors for the MCP client OAuth flow.
 * Mirrors the `AuthError` pattern from `src/core/auth/domain/errors.ts`
 * (same layering), but scoped to outbound client-side concerns so routes
 * and use-cases can switch exhaustively without overloading the other
 * module.
 */
export type McpAuthClientError =
  | { kind: 'server_not_found'; serverId: string }
  | { kind: 'registration_not_found'; serverId: string }
  | { kind: 'tokens_not_found'; serverId: string }
  | { kind: 'discovery_failed'; reason: string }
  | { kind: 'dcr_not_supported' }
  | { kind: 'dcr_failed'; status: number; body: string }
  | { kind: 'token_exchange_failed'; status: number; body: string }
  | { kind: 'invalid_state' }
  | { kind: 'state_expired' }
  | { kind: 'state_already_consumed' }
  | { kind: 'refresh_reuse_detected' }
  | { kind: 'refresh_failed'; status: number; body: string }
  | { kind: 'needs_reauth'; reason: string };

export function mcpAuthClientErrorMessage(err: McpAuthClientError): string {
  switch (err.kind) {
    case 'server_not_found': return `MCP server '${err.serverId}' not found`;
    case 'registration_not_found': return `MCP server '${err.serverId}' has no OAuth registration`;
    case 'tokens_not_found': return `MCP server '${err.serverId}' has no stored OAuth tokens`;
    case 'discovery_failed': return `Authorization server discovery failed: ${err.reason}`;
    case 'dcr_not_supported': return 'The authorization server does not support Dynamic Client Registration';
    case 'dcr_failed': return `DCR failed (${err.status}): ${err.body}`;
    case 'token_exchange_failed': return `Token exchange failed (${err.status}): ${err.body}`;
    case 'invalid_state': return 'Authorization state parameter is invalid or unknown';
    case 'state_expired': return 'Authorization request has expired; start again';
    case 'state_already_consumed': return 'Authorization code already consumed';
    case 'refresh_reuse_detected': return 'Refresh token reuse detected — chain revoked';
    case 'refresh_failed': return `Refresh failed (${err.status}): ${err.body}`;
    case 'needs_reauth': return `Re-authorization required: ${err.reason}`;
  }
}
