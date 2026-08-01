import type { BuiltInAgentPreset, CustomAgentPreset } from '@mcp/api-bus';

export interface CustomAgent {
  id: string;
  selectionId: CustomAgentPreset;
  name: string;
  description: string;
  baseAgentId: BuiltInAgentPreset;
  prompt: string;
  skillIds: string[];
  pinnedToolNames: string[];
  requiredToolTiers: string[];
  visibleToolCap: number | null;
  toolNames: string[] | null;
  enabled: boolean;
  managedBy: string | null;
  managedVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomAgentDraft {
  name: string;
  description: string;
  baseAgentId: BuiltInAgentPreset;
  prompt: string;
  skillIds: string[];
  toolNames: string[] | null;
  enabled: boolean;
}

export interface AgentPresetSummary {
  id: BuiltInAgentPreset;
  label: string;
  description: string;
  profile: string;
  planMode: boolean;
  /** Static catalog inherited from the preset before runtime-only context tiers are added. */
  defaultToolNames: string[];
  defaultToolTiers: string[];
}

async function responseError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  return new Error(body.error || `HTTP ${response.status}`);
}

export async function fetchCustomAgents(): Promise<{
  agents: CustomAgent[];
  presets: AgentPresetSummary[];
}> {
  const response = await fetch('/api/admin/custom-agents');
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<{ agents: CustomAgent[]; presets: AgentPresetSummary[] }>;
}

export async function saveCustomAgent(
  id: string | null,
  draft: CustomAgentDraft,
): Promise<CustomAgent> {
  const response = await fetch(id ? `/api/admin/custom-agents/${encodeURIComponent(id)}` : '/api/admin/custom-agents', {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<CustomAgent>;
}

export async function removeCustomAgent(id: string): Promise<void> {
  const response = await fetch(`/api/admin/custom-agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw await responseError(response);
}
