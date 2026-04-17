import type { TokenType } from './auth-context.js';

export type AuditEventKind =
  | 'auth_ok'
  | 'auth_fail'
  | 'scope_denied'
  | 'rate_limited'
  | 'tool_call_ok'
  | 'tool_call_error'
  | 'token_issued'
  | 'token_revoked'
  | 'client_registered'
  | 'client_revoked'
  | 'code_exchanged'
  | 'refresh_rotated';

export interface AuditEvent {
  readonly at: number;                           // unix ms
  readonly principal: string | null;             // tokenId / clientId / null for anonymous
  readonly tokenType: TokenType | null;
  readonly event: AuditEventKind;
  readonly status: number;                       // HTTP status (200, 401, 403, 429, ...)
  readonly toolName: string | null;
  readonly meta: Readonly<Record<string, unknown>>;
}
