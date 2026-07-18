import { randomUUID } from 'node:crypto';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import {
  AGENTS,
  isAgentId,
  type AgentDefinition,
  type AgentId,
} from '@mcp/code-agent/agents/index.js';

export const CUSTOM_AGENTS_SETTING_KEY = 'coder_custom_agents_v1';
export const CUSTOM_AGENT_PREFIX = 'custom:' as const;

export type CustomAgentSelectionId = `${typeof CUSTOM_AGENT_PREFIX}${string}`;
export type AgentSelectionId = AgentId | CustomAgentSelectionId;

export interface CustomAgentDefinition {
  id: string;
  selectionId: CustomAgentSelectionId;
  name: string;
  description: string;
  baseAgentId: AgentId;
  prompt: string;
  skillIds: string[];
  /** null inherits the preset/profile catalog; [] intentionally exposes no tools. */
  toolNames: string[] | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CustomAgentInput {
  name?: unknown;
  description?: unknown;
  baseAgentId?: unknown;
  prompt?: unknown;
  skillIds?: unknown;
  toolNames?: unknown;
  enabled?: unknown;
}

export interface ResolvedAgentSelection {
  selectionId: AgentSelectionId;
  baseAgentId: AgentId;
  base: AgentDefinition;
  custom?: CustomAgentDefinition;
}

type CustomAgentStore = Pick<ProviderStore, 'getAppSetting' | 'setAppSetting'>;

export class CustomAgentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomAgentValidationError';
  }
}

function selectionIdFor(id: string): CustomAgentSelectionId {
  return `${CUSTOM_AGENT_PREFIX}${id}`;
}

function uniqueStrings(value: unknown, field: string, limit: number): string[] {
  if (!Array.isArray(value)) throw new CustomAgentValidationError(`${field} must be an array`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') throw new CustomAgentValidationError(`${field} must contain only strings`);
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    if (normalized.length > 240) throw new CustomAgentValidationError(`${field} contains an invalid identifier`);
    seen.add(normalized);
    out.push(normalized);
    if (out.length > limit) throw new CustomAgentValidationError(`${field} supports at most ${limit} items`);
  }
  return out;
}

function cleanText(value: unknown, field: string, maxLength: number, required = false): string {
  if (value == null) value = '';
  if (typeof value !== 'string') throw new CustomAgentValidationError(`${field} must be a string`);
  const normalized = value.trim();
  if (required && !normalized) throw new CustomAgentValidationError(`${field} is required`);
  if (normalized.length > maxLength) {
    throw new CustomAgentValidationError(`${field} supports at most ${maxLength} characters`);
  }
  return normalized;
}

function normalizeStoredAgent(value: unknown): CustomAgentDefinition | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(row.id)) return null;
  if (typeof row.name !== 'string' || !row.name.trim()) return null;
  if (typeof row.baseAgentId !== 'string' || !isAgentId(row.baseAgentId)) return null;
  const createdAt = typeof row.createdAt === 'string' ? row.createdAt : new Date(0).toISOString();
  const updatedAt = typeof row.updatedAt === 'string' ? row.updatedAt : createdAt;
  return {
    id: row.id,
    selectionId: selectionIdFor(row.id),
    name: row.name.trim().slice(0, 80),
    description: typeof row.description === 'string' ? row.description.trim().slice(0, 240) : '',
    baseAgentId: row.baseAgentId,
    prompt: typeof row.prompt === 'string' ? row.prompt.trim().slice(0, 50_000) : '',
    skillIds: Array.isArray(row.skillIds)
      ? [...new Set(row.skillIds.filter((id): id is string => typeof id === 'string').map((id) => id.trim()).filter(Boolean))].slice(0, 100)
      : [],
    toolNames: row.toolNames === null
      ? null
      : Array.isArray(row.toolNames)
        ? [...new Set(row.toolNames.filter((name): name is string => typeof name === 'string').map((name) => name.trim()).filter(Boolean))].slice(0, 300)
        : null,
    enabled: row.enabled !== false,
    createdAt,
    updatedAt,
  };
}

export function listCustomAgents(store: CustomAgentStore): CustomAgentDefinition[] {
  const raw = store.getAppSetting(CUSTOM_AGENTS_SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeStoredAgent)
      .filter((agent): agent is CustomAgentDefinition => agent !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function persistCustomAgents(store: CustomAgentStore, agents: CustomAgentDefinition[]): void {
  store.setAppSetting(
    CUSTOM_AGENTS_SETTING_KEY,
    JSON.stringify(agents.map(({ selectionId: _selectionId, ...agent }) => agent)),
  );
}

function normalizeInput(
  input: CustomAgentInput,
  previous?: CustomAgentDefinition,
): Omit<CustomAgentDefinition, 'id' | 'selectionId' | 'createdAt' | 'updatedAt'> {
  const baseAgentId = input.baseAgentId ?? previous?.baseAgentId;
  if (typeof baseAgentId !== 'string' || !isAgentId(baseAgentId)) {
    throw new CustomAgentValidationError(`baseAgentId must be one of ${Object.keys(AGENTS).join('|')}`);
  }
  const toolSource = input.toolNames === undefined ? (previous?.toolNames ?? null) : input.toolNames;
  return {
    name: cleanText(input.name ?? previous?.name, 'name', 80, true),
    description: cleanText(input.description ?? previous?.description, 'description', 240),
    baseAgentId,
    prompt: cleanText(input.prompt ?? previous?.prompt, 'prompt', 50_000),
    skillIds: uniqueStrings(input.skillIds ?? previous?.skillIds ?? [], 'skillIds', 100),
    toolNames: toolSource === null ? null : uniqueStrings(toolSource, 'toolNames', 300),
    enabled: typeof input.enabled === 'boolean' ? input.enabled : (previous?.enabled ?? true),
  };
}

export function createCustomAgent(store: CustomAgentStore, input: CustomAgentInput): CustomAgentDefinition {
  const now = new Date().toISOString();
  const id = randomUUID();
  const agent: CustomAgentDefinition = {
    id,
    selectionId: selectionIdFor(id),
    ...normalizeInput(input),
    createdAt: now,
    updatedAt: now,
  };
  persistCustomAgents(store, [...listCustomAgents(store), agent]);
  return agent;
}

export function updateCustomAgent(
  store: CustomAgentStore,
  id: string,
  input: CustomAgentInput,
): CustomAgentDefinition | null {
  const agents = listCustomAgents(store);
  const index = agents.findIndex((agent) => agent.id === id);
  if (index < 0) return null;
  const previous = agents[index]!;
  const next: CustomAgentDefinition = {
    ...previous,
    ...normalizeInput(input, previous),
    updatedAt: new Date().toISOString(),
  };
  agents[index] = next;
  persistCustomAgents(store, agents);
  return next;
}

export function deleteCustomAgent(store: CustomAgentStore, id: string): boolean {
  const agents = listCustomAgents(store);
  const next = agents.filter((agent) => agent.id !== id);
  if (next.length === agents.length) return false;
  persistCustomAgents(store, next);
  return true;
}

export function resolveAgentSelection(
  store: CustomAgentStore,
  value: unknown,
  options: { includeDisabled?: boolean } = {},
): ResolvedAgentSelection | null {
  if (typeof value !== 'string') return null;
  if (isAgentId(value)) {
    return { selectionId: value, baseAgentId: value, base: AGENTS[value] };
  }
  if (!value.startsWith(CUSTOM_AGENT_PREFIX)) return null;
  const id = value.slice(CUSTOM_AGENT_PREFIX.length);
  const custom = listCustomAgents(store).find((agent) => agent.id === id);
  if (!custom || (!options.includeDisabled && !custom.enabled)) return null;
  return {
    selectionId: custom.selectionId,
    baseAgentId: custom.baseAgentId,
    base: AGENTS[custom.baseAgentId],
    custom,
  };
}
