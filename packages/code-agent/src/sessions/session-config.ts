import type { CoderExecutionMode } from './types.js';

export interface SessionConfigLock {
  provider: string;
  model: string;
  permissionMode: string;
  executionMode: CoderExecutionMode;
  reasoningEffort: string | null;
  planDepth: string | null;
  responseLanguage: string | null;
  outputStyle: string | null;
  temperature: number | null;
  toolOutputCapLevel: string | null;
  capturedAtMs: number;
}

export interface ConfigLockInput {
  provider: string;
  model: string;
  permissionMode: string;
  executionMode?: CoderExecutionMode;
  reasoningEffort?: string | null;
  planDepth?: string | null;
  responseLanguage?: string | null;
  outputStyle?: string | null;
  temperature?: number | null;
  toolOutputCapLevel?: string | null;
  nowMs: number;
}

/** Materialize the immutable, JSON-backed session config projection. */
export function buildConfigLock(input: ConfigLockInput): SessionConfigLock {
  const reasoningEffort = input.reasoningEffort ?? null;
  const legacyUltra = typeof reasoningEffort === 'string'
    && reasoningEffort.trim().toLowerCase() === 'ultra';
  return {
    provider: input.provider,
    model: input.model,
    permissionMode: input.permissionMode,
    executionMode: input.executionMode ?? (legacyUltra ? 'ultra' : 'standard'),
    reasoningEffort: legacyUltra ? null : reasoningEffort,
    planDepth: input.planDepth ?? null,
    responseLanguage: input.responseLanguage ?? null,
    outputStyle: input.outputStyle ?? null,
    temperature: input.temperature ?? null,
    toolOutputCapLevel: input.toolOutputCapLevel ?? null,
    capturedAtMs: input.nowMs,
  };
}

export function diffConfigLock(
  stored: SessionConfigLock,
  current: SessionConfigLock,
): string[] {
  const fields: (keyof SessionConfigLock)[] = [
    'provider',
    'model',
    'permissionMode',
    'executionMode',
    'reasoningEffort',
    'planDepth',
    'responseLanguage',
    'outputStyle',
    'temperature',
    'toolOutputCapLevel',
  ];
  const drift: string[] = [];
  for (const field of fields) {
    if (stored[field] !== current[field]) {
      drift.push(
        `${field}: ${String(stored[field])} → ${String(current[field])}`,
      );
    }
  }
  return drift;
}

/** Normalize pre-execution-mode snapshots while reading state.json. */
export function normalizeConfigLock(value: unknown): SessionConfigLock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const lock = value as Record<string, unknown>;
  const reasoningEffort =
    typeof lock.reasoningEffort === 'string' || lock.reasoningEffort === null
      ? lock.reasoningEffort
      : null;
  const legacyUltra = typeof reasoningEffort === 'string'
    && reasoningEffort.trim().toLowerCase() === 'ultra';
  const explicitMode: CoderExecutionMode | null =
    lock.executionMode === 'ultra'
      ? 'ultra'
      : lock.executionMode === 'standard'
        ? 'standard'
        : null;
  return {
    ...(lock as unknown as SessionConfigLock),
    executionMode: explicitMode ?? (legacyUltra ? 'ultra' : 'standard'),
    reasoningEffort: legacyUltra ? null : reasoningEffort,
  };
}
