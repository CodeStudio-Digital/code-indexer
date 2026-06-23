/**
 * MCP tier — mirrors the agent's static tool tiers
 * (bootstrap < navigate < admin). When set on a token, the MCP HTTP
 * endpoint filters/gates tools by tier (read more in migration 104).
 */
export type McpTier = 'bootstrap' | 'navigate' | 'admin';

export interface ApiTokenRow {
  id: string;
  name: string;
  scopes: string[];
  expires_at: number | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  tier: McpTier | null;
}

export interface McpHttpToolRow {
  name: string;
  tier: string;
  description: string;
}

export interface McpHttpStatus {
  enabled: boolean;
  authEnabled: boolean;
  stateful: boolean;
  endpoint: string;
  port: number;
  path: string;
  tools: McpHttpToolRow[];
  counts: {
    total: number;
    bootstrap: number;
    navigate: number;
    admin: number;
  };
}

export interface OAuthClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  scopes: string[];
  token_endpoint_auth_method: string;
  created_at: number;
  revoked_at: number | null;
}

export interface AuditEventRow {
  at: number;
  principal: string | null;
  tokenType: 'api_token' | 'oauth' | null;
  event: string;
  status: number;
  toolName: string | null;
  meta: Record<string, unknown>;
}

export async function listApiTokens(): Promise<ApiTokenRow[]> {
  const r = await fetch('/api/admin/api-tokens');
  const j = (await r.json()) as { tokens: ApiTokenRow[] };
  return j.tokens;
}

export async function createApiToken(input: {
  name: string;
  scopes?: string[];
  expiresInDays?: number;
  tier?: McpTier | null;
}): Promise<{ id: string; rawToken: string; tier: McpTier | null }> {
  const r = await fetch('/api/admin/api-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({ error: 'unknown' }))).error);
  return (await r.json()) as { id: string; rawToken: string; tier: McpTier | null };
}

export async function fetchMcpHttpStatus(): Promise<McpHttpStatus> {
  const r = await fetch('/api/admin/mcp-http/status');
  if (!r.ok) throw new Error(`mcp-http/status failed: ${r.status}`);
  return (await r.json()) as McpHttpStatus;
}

export async function revokeApiToken(id: string): Promise<void> {
  await fetch(`/api/admin/api-tokens/${id}`, { method: 'DELETE' });
}

export async function listOAuthClients(): Promise<OAuthClientRow[]> {
  const r = await fetch('/api/admin/oauth-clients');
  const j = (await r.json()) as { clients: OAuthClientRow[] };
  return j.clients;
}

export async function revokeOAuthClient(clientId: string): Promise<void> {
  await fetch(`/api/admin/oauth-clients/${clientId}`, { method: 'DELETE' });
}

export async function fetchAuditLog(filter: {
  since?: number;
  until?: number;
  principal?: string;
  event?: string;
  limit?: number;
} = {}): Promise<AuditEventRow[]> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) {
    if (v !== undefined && v !== '') q.set(k, String(v));
  }
  const r = await fetch(`/api/admin/audit-log?${q}`);
  const j = (await r.json()) as { events: AuditEventRow[] };
  return j.events;
}
