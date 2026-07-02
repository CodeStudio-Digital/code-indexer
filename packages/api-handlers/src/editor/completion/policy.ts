/**
 * Latency policy for autocomplete — one `aggressiveness` knob maps to
 * debounce/cache-TTL/suppression, plus an adaptive debounce component: a fast
 * provider (p50 < 500ms over the last 20 OK calls) earns a shorter debounce,
 * a slow one backs off. Explicit `debounce_ms` in the binding config always
 * wins over the derived base. All state is module-level (Electron
 * dual-factory) keyed per provider:model.
 */

export type Aggressiveness = 'economic' | 'balanced' | 'responsive';
export type Suppression = 'strict' | 'standard' | 'lenient';

export interface LatencyPolicy {
  aggressiveness: Aggressiveness;
  debounceBaseMs: number;
  /** Explicit debounce_ms config — bypasses base AND adaptive. */
  debounceOverrideMs: number | null;
  cacheTtlMs: number;
  suppression: Suppression;
  adaptiveFloorMs: number;
}

const POLICY_TABLE: Record<Aggressiveness, Omit<LatencyPolicy, 'aggressiveness' | 'debounceOverrideMs'>> = {
  economic:   { debounceBaseMs: 250, cacheTtlMs: 90_000, suppression: 'strict',   adaptiveFloorMs: 180 },
  balanced:   { debounceBaseMs: 180, cacheTtlMs: 60_000, suppression: 'standard', adaptiveFloorMs: 120 },
  responsive: { debounceBaseMs: 120, cacheTtlMs: 45_000, suppression: 'lenient',  adaptiveFloorMs: 80 },
};

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

export function resolveLatencyPolicy(cfg: Record<string, unknown>): LatencyPolicy {
  const agg: Aggressiveness = cfg.aggressiveness === 'economic' || cfg.aggressiveness === 'responsive'
    ? cfg.aggressiveness
    : 'balanced';
  return { aggressiveness: agg, debounceOverrideMs: num(cfg.debounce_ms), ...POLICY_TABLE[agg] };
}

// ── Adaptive debounce (rolling OK-latency window per binding) ──────────────
const WINDOW_CAP = 20;
const FAST_P50_MS = 500;
const SLOW_P50_MS = 1500;
const FAST_BONUS_MS = 60;
const SLOW_PENALTY_MS = 120;

const latencyWindows = new Map<string, number[]>();

export function noteOkLatency(bindingKey: string, ms: number): void {
  let win = latencyWindows.get(bindingKey);
  if (!win) { win = []; latencyWindows.set(bindingKey, win); }
  win.push(ms);
  if (win.length > WINDOW_CAP) win.shift();
  if (latencyWindows.size > 16) {
    const oldest = latencyWindows.keys().next().value;
    if (oldest !== undefined && oldest !== bindingKey) latencyWindows.delete(oldest);
  }
}

function p50(win: number[]): number {
  const sorted = [...win].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * The debounce to hand the client for THIS request. Computed once per request
 * and returned on every outcome (cache/forward hits included) so the client
 * value never oscillates between hit and miss paths.
 */
export function adaptiveDebounce(bindingKey: string, policy: LatencyPolicy): number {
  if (policy.debounceOverrideMs !== null) return policy.debounceOverrideMs;
  const win = latencyWindows.get(bindingKey);
  if (!win || win.length < 5) return policy.debounceBaseMs;
  const mid = p50(win);
  if (mid < FAST_P50_MS) return Math.max(policy.adaptiveFloorMs, policy.debounceBaseMs - FAST_BONUS_MS);
  if (mid > SLOW_P50_MS) return policy.debounceBaseMs + SLOW_PENALTY_MS;
  return policy.debounceBaseMs;
}

/** Test hook. */
export function __resetLatencyPolicyForTests(): void {
  latencyWindows.clear();
}

// ── Generation params ──────────────────────────────────────────────────────
const FIM_TEMP_DEFAULT = 0.05;
const CHAT_TEMP_DEFAULT = 0.2;
const MULTILINE_TOKENS_DEFAULT = 256;
const SINGLE_LINE_TOKENS_DEFAULT = 64;

export function resolveGenParams(
  cfg: Record<string, unknown>,
  endpoint: 'fim' | 'chat',
  multiline: boolean,
): { temperature: number; maxTokens: number } {
  // temperature: 0 is a legitimate explicit value — don't treat it as unset.
  const explicitTemp = typeof cfg.temperature === 'number' && Number.isFinite(cfg.temperature) && cfg.temperature >= 0
    ? cfg.temperature
    : null;
  const temperature = explicitTemp
    ?? (endpoint === 'fim' ? FIM_TEMP_DEFAULT : CHAT_TEMP_DEFAULT);
  const maxTokens = multiline
    ? num(cfg.max_tokens) ?? MULTILINE_TOKENS_DEFAULT
    : num(cfg.max_tokens_single_line) ?? SINGLE_LINE_TOKENS_DEFAULT;
  return { temperature, maxTokens };
}
