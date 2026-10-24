export interface ToolConfigItem {
  name: string;
  tier: string;
  source: 'native' | 'mcp' | 'mcp_external';
  description: string;
  globallyDisabled: boolean;
}

export async function fetchToolConfigs(): Promise<ToolConfigItem[]> {
  const r = await fetch('/api/admin/tools');
  const j = (await r.json()) as { tools: ToolConfigItem[] };
  return j.tools;
}

export async function setToolGlobalDisabled(toolName: string, disabled: boolean): Promise<void> {
  await fetch(`/api/admin/tools/${encodeURIComponent(toolName)}/disabled`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled }),
  });
}

async function bulkSetToolsDisabled(
  tools: Array<{ name: string; disabled: boolean }>,
): Promise<void> {
  await fetch('/api/admin/tools/bulk-disabled', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tools }),
  });
}
