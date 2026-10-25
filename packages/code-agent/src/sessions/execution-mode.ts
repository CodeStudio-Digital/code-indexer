import type { CoderExecutionMode } from './types.js';

export interface SessionExecutionPolicy {
  ultraEnabled: boolean;
  reasoningEffort: string | undefined;
}

/** Orchestration and provider reasoning are independent; migrate legacy markers. */
export function resolveSessionExecutionPolicy(
  mode: CoderExecutionMode | null | undefined,
  requestedEffort: string | null | undefined,
): SessionExecutionPolicy {
  const effort = requestedEffort?.trim() || undefined;
  const legacyUltra = effort?.toLowerCase() === 'ultra';
  return { ultraEnabled: mode === 'ultra' || legacyUltra, reasoningEffort: legacyUltra ? undefined : effort };
}

/** Only an explicit leading composer command activates Ultra for one request. */
export function detectTurnUltraKeyword(
  userMessage: string | null | undefined,
  sessionUltraEnabled: boolean,
): boolean {
  return !sessionUltraEnabled && /^\s*\/(?:ultra|ultracode)(?:\s|$)/i.test(userMessage ?? '');
}
