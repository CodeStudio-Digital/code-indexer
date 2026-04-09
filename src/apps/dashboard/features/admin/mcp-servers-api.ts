export type McpTransport = 'stdio' | 'sse' | 'streamable_http';
export type McpAuthType = 'none' | 'api_key' | 'bearer';
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
