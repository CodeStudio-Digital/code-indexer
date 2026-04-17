export type McpTransport = 'stdio' | 'sse' | 'streamable_http';
export type McpAuthType = 'none' | 'api_key' | 'bearer' | 'oauth2';
/** Core tiers or a custom tier name (e.g., 'cloudflare', 'github'). */
export type McpDefaultTier = string;

export interface AdminMcpServer {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  url: string | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  auth_type: McpAuthType;
  auth_token_masked: string | null;
  has_token: boolean;
  default_tier: McpDefaultTier;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface McpServerToolInfo {
  name: string;
  description: string;
}

export interface McpServerTestResult {
  ok: boolean;
  toolCount?: number;
  latencyMs?: number;
  error?: string;
  tools?: McpServerToolInfo[];
}

export async function fetchMcpServers(): Promise<AdminMcpServer[]> {
  const r = await fetch('/api/admin/mcp-servers');
  const j = (await r.json()) as { servers: AdminMcpServer[] };
  return j.servers;
}

export async function saveMcpServer(
  s: Partial<AdminMcpServer> & { auth_token?: string | null },
  isExisting: boolean,
): Promise<void> {
  const method = isExisting ? 'PATCH' : 'POST';
  const url = isExisting ? `/api/admin/mcp-servers/${s.id}` : '/api/admin/mcp-servers';
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s),
  });
  if (!r.ok) {
    const err = (await r.json()) as { error: string };
    throw new Error(err.error);
  }
}

export async function deleteMcpServer(id: string): Promise<void> {
  await fetch(`/api/admin/mcp-servers/${id}`, { method: 'DELETE' });
}

export async function testMcpServer(id: string): Promise<McpServerTestResult> {
  const r = await fetch(`/api/admin/mcp-servers/${id}/test`, { method: 'POST' });
  return (await r.json()) as McpServerTestResult;
}

export async function fetchServerTools(id: string): Promise<McpServerToolInfo[]> {
  const r = await fetch(`/api/admin/mcp-servers/${id}/tools`);
  if (!r.ok) return [];
  const j = (await r.json()) as { tools: McpServerToolInfo[] };
  return j.tools;
}

// ── OAuth 2.1 client flow ──────────────────────────────────────────────

export interface McpOAuthStatus {
  server_id: string;
  status: 'registered' | 'not_registered';
  registration: {
    issuer: string;
    client_id: string;
    scopes: string[];
    redirect_uri: string;
    source: 'dcr' | 'manual';
  } | null;
}

export async function fetchOAuthStatus(serverId: string): Promise<McpOAuthStatus> {
  const r = await fetch(`/api/admin/mcp-servers/${serverId}/oauth/status`);
  return (await r.json()) as McpOAuthStatus;
}

/**
 * Runs discovery + DCR in one shot. Returns the newly registered client_id.
 * For manual registration (AS does not support DCR), pass a pre-obtained
 * client_id (and optional secret) and the resolved AS metadata in `manual`.
 */
export async function registerOAuthClient(
  serverId: string,
  input:
    | { mode: 'dcr'; resource_url: string; client_name?: string; scopes?: string[] }
    | {
        mode: 'manual';
        as: Record<string, unknown>;
        client_id: string;
        client_secret?: string;
        scopes?: string[];
      },
): Promise<{ client_id: string; source: 'dcr' | 'manual' }> {
  const body =
    input.mode === 'dcr'
      ? {
          resource_url: input.resource_url,
          client_name: input.client_name,
          scopes: input.scopes,
        }
      : {
          as: input.as,
          client_id: input.client_id,
          client_secret: input.client_secret,
          scopes: input.scopes,
        };
  const r = await fetch(`/api/admin/mcp-servers/${serverId}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const e = (await r.json().catch(() => ({}))) as { error_description?: string; error?: string };
    throw new Error(e.error_description ?? e.error ?? 'register failed');
  }
  return (await r.json()) as { client_id: string; source: 'dcr' | 'manual' };
}

export async function startOAuthAuthorize(
  serverId: string,
): Promise<{ authorization_url: string; state: string }> {
  const r = await fetch(`/api/admin/mcp-servers/${serverId}/oauth/authorize`, {
    method: 'POST',
  });
  if (!r.ok) {
    const e = (await r.json().catch(() => ({}))) as { error_description?: string };
    throw new Error(e.error_description ?? 'authorize failed');
  }
  return (await r.json()) as { authorization_url: string; state: string };
}

export async function revokeMcpOAuth(serverId: string): Promise<void> {
  await fetch(`/api/admin/mcp-servers/${serverId}/oauth`, { method: 'DELETE' });
}
