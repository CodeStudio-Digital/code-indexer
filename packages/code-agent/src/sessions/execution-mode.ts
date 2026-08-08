import type { CoderExecutionMode } from './types.js';

export interface SessionExecutionPolicy {
  ultraEnabled: boolean;
  /** Internal marker or provider-native effort; never an empty string. */
  reasoningEffort: string | undefined;
}

/**
 * Resolve the product execution profile independently of provider controls.
 * A literal legacy `reasoningEffort=ultra` remains authoritative even after
 * migration 241 added a NOT NULL `standard` default, covering callers that
 * persist session config without going through the HTTP compatibility route.
 */
export function resolveSessionExecutionPolicy(
  mode: CoderExecutionMode | null | undefined,
  requestedEffort: string | null | undefined,
): SessionExecutionPolicy {
  const effort = requestedEffort?.trim() || undefined;
  const legacyUltra = effort?.toLowerCase() === 'ultra';
  const ultraEnabled = mode === 'ultra' || legacyUltra;
  return {
    ultraEnabled,
    reasoningEffort: ultraEnabled ? 'ultra' : effort,
  };
}

const TURN_ULTRA_KEYWORD_RE = /\bultracode\b/i;

/**
 * Per-TURN Ultra trigger (Claude-Code-style `ultracode` keyword): the user
 * writes `ultracode` anywhere in the message and THAT run executes with the
 * full Ultra posture (max reasoning, workflow tool, proactive delegation)
 * without touching the session's sticky execution mode. Deliberately only the
 * unambiguous token — bare "ultra" appears in normal prose (and in talk ABOUT
 * the mode) far too often.
 */
export function detectTurnUltraKeyword(
  userMessage: string | null | undefined,
  sessionUltraEnabled: boolean,
): boolean {
  if (sessionUltraEnabled) return false;
  return TURN_ULTRA_KEYWORD_RE.test(userMessage ?? '');
}
