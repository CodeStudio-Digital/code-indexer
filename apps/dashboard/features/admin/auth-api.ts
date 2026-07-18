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
  profile_id: string | null;
}

export interface McpConnectionProfile {
  id: string;
  name: string;
  description: string;
  projectIds: number[];
  toolAllowlist: string[];
  agentAllowlist: string[];
  approvalMode: 'read_only' | 'controlled' | 'admin';
  maxConcurrentRuns: number;
  maxRuntimeMs: number;
  createdAt: number;
  updatedAt: number;
}

export interface McpHttpToolRow {
  name: string;
  tier: string;
  scope: string;
  readOnly: boolean;
  description: string;
}

export interface McpHttpStatus {
  enabled: boolean;
  authEnabled: boolean;
  stateful: boolean;
  endpoint: string;
  configs: {
    claudeCode: string;
    codex: string;
  };
  port: number;
  path: string;
  projects: Array<{ id: number; name: string; rootPath: string }>;
  agents: Array<{ id: string; name: string; description: string }>;
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
  profileId?: string | null;
}): Promise<{ id: string; rawToken: string; tier: McpTier | null; profileId: string | null }> {
  const r = await fetch('/api/admin/api-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({ error: 'unknown' }))).error);
  return (await r.json()) as { id: string; rawToken: string; tier: McpTier | null; profileId: string | null };
}

export async function fetchMcpHttpStatus(): Promise<McpHttpStatus> {
  const r = await fetch('/api/admin/mcp-http/status');
  if (!r.ok) throw new Error(`mcp-http/status failed: ${r.status}`);
  return (await r.json()) as McpHttpStatus;
}

export async function listMcpConnectionProfiles(): Promise<McpConnectionProfile[]> {
  const r = await fetch('/api/admin/mcp-http/profiles');
  if (!r.ok) throw new Error(`mcp-http/profiles failed: ${r.status}`);
  return ((await r.json()) as { profiles: McpConnectionProfile[] }).profiles;
}

export async function saveMcpConnectionProfile(
  input: Omit<McpConnectionProfile, 'createdAt' | 'updatedAt'>,
): Promise<McpConnectionProfile> {
  const r = await fetch('/api/admin/mcp-http/profiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await r.json() as { profile?: McpConnectionProfile; error?: string };
  if (!r.ok || !payload.profile) throw new Error(payload.error ?? `profile save failed: ${r.status}`);
  return payload.profile;
}

export async function deleteMcpConnectionProfile(id: string): Promise<void> {
  const r = await fetch(`/api/admin/mcp-http/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 404) throw new Error(`profile delete failed: ${r.status}`);
}

export async function exportMcpAgent(agentId: string, target: 'claude' | 'codex'): Promise<{
  fileName: string;
  content: string;
}> {
  const q = new URLSearchParams({ agent_id: agentId, target });
  const r = await fetch(`/api/admin/mcp-http/agent-export?${q}`);
  const payload = await r.json() as { fileName?: string; content?: string; error?: string };
  if (!r.ok || !payload.fileName || payload.content === undefined) {
    throw new Error(payload.error ?? `agent export failed: ${r.status}`);
  }
  return { fileName: payload.fileName, content: payload.content };
}

export async function installCodexMcpBridge(): Promise<{ note: string }> {
  const r = await fetch('/api/admin/mcp-http/codex-bridge', { method: 'POST' });
  const payload = await r.json() as { note?: string; error?: string };
  if (!r.ok) throw new Error(payload.error ?? `Codex bridge failed: ${r.status}`);
  return { note: payload.note ?? 'Codex bridge registered.' };
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
