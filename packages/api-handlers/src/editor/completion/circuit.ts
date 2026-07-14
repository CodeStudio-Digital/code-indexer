import type { EditorCompletionHealth } from '@mcp/api-bus';
import type { ResolvedBinding } from '@mcp/services/pipelines/provider-resolver.js';
import { completionBindingRevision } from '@mcp/services/quality/completion-compatibility.js';
import type { ChatCallResult } from '@mcp/services/quality/llm-chat.js';

interface CircuitState {
  until: number;
  health: EditorCompletionHealth;
  reason: string;
}

const circuits = new Map<string, CircuitState>();

export function circuitKey(binding: ResolvedBinding, projectId: number): string {
  return `${projectId}:${completionBindingRevision(binding)}`;
}

export function circuitStatus(binding: ResolvedBinding, projectId: number): CircuitState | null {
  const key = circuitKey(binding, projectId);
  const state = circuits.get(key);
  if (!state) return null;
  if (state.until !== Number.POSITIVE_INFINITY && state.until <= Date.now()) {
    circuits.delete(key);
    return null;
  }
  return state;
}

export function bindingCircuitHealth(binding: ResolvedBinding): CircuitState | null {
  const suffix = `:${completionBindingRevision(binding)}`;
  for (const [key, state] of circuits) {
    if (!key.endsWith(suffix)) continue;
    if (state.until !== Number.POSITIVE_INFINITY && state.until <= Date.now()) {
      circuits.delete(key);
      continue;
    }
    return state;
  }
  return null;
}

/** Select once per request. A failure only affects the next keystroke. */
export function selectCircuitBinding(
  chain: ResolvedBinding[],
  projectId: number,
): { binding: ResolvedBinding; health: EditorCompletionHealth; reason?: string } | null {
  for (const binding of chain) {
    const state = circuitStatus(binding, projectId);
    if (!state) return { binding, health: 'unknown' };
  }
  return null;
}

export function noteCircuitSuccess(binding: ResolvedBinding, projectId: number): void {
  circuits.delete(circuitKey(binding, projectId));
}

export function noteCircuitFailure(
  binding: ResolvedBinding,
  projectId: number,
  result: Pick<ChatCallResult, 'status' | 'retryAfterMs' | 'finishReason' | 'errorBody'>,
  timeoutMs: number,
): CircuitState {
  let health: EditorCompletionHealth = 'degraded';
  let cooldown = Math.max(3_000, Math.min(15_000, timeoutMs));
  let reason = 'Transient provider failure; the next binding will be used on the next request.';
  if (result.status === 401 || result.status === 403) {
    health = 'auth-blocked';
    cooldown = Number.POSITIVE_INFINITY;
    reason = 'Authentication failed; blocked until the binding configuration changes.';
  } else if (result.status === 429) {
    health = 'rate-limited';
    cooldown = result.retryAfterMs ?? 30_000;
    reason = `Rate limited; retry after ${Math.ceil(cooldown / 1000)}s.`;
  } else if (result.finishReason === 'timeout' || /abort|timeout/i.test(result.errorBody ?? '')) {
    health = 'circuit-open';
    reason = `Timed out; circuit open for ${Math.ceil(cooldown / 1000)}s.`;
  } else if (result.status === 400 || result.status === 404) {
    cooldown = 5 * 60_000;
    reason = 'Completion endpoint/configuration was rejected; circuit parked for 5 minutes.';
  }
  const state = { until: cooldown === Number.POSITIVE_INFINITY ? cooldown : Date.now() + cooldown, health, reason };
  circuits.set(circuitKey(binding, projectId), state);
  return state;
}

export function __resetCompletionCircuitsForTests(): void {
  circuits.clear();
}
