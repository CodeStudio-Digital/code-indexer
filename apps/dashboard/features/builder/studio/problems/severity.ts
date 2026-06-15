/**
 * Pure noise filter for the preview problems feed. Classifies a raw
 * preview message BEFORE it enters the ring buffer so neither the badge
 * nor the auto-fix loop ever see problems that no agent should act on
 * (favicon 404s, sourcemap fetches, HMR plumbing, extension scripts).
 *
 * Conservative on purpose: anything not provably noise is actionable —
 * a false "actionable" costs one badge row; a false "noise" hides a bug.
 */
import type { ProblemMessage } from '../studio-context-store.js';

const NOISE_URL_RE = [
  /\/favicon\.[a-z0-9]+(\?|$)/i,
  /\.map(\?|$)/i, // sourcemap fetches
  /[?&]t=\d+.*\bhot-update\b|\bhot-update\b/i, // webpack/vite HMR chunks
  /^chrome-extension:\/\//i,
  /^moz-extension:\/\//i,
  /\/@vite\/client/i,
  /\/__vite_ping(\?|$)/i,
];

const NOISE_RUNTIME_RE = [
  // Benign browser noise — not fixable from app code.
  /^ResizeObserver loop/i,
  // Cross-origin scripts surface as an opaque "Script error." with no
  // stack — nothing for the agent to act on.
  /^Script error\.?$/i,
];

export type ProblemSeverity = 'actionable' | 'noise';

export function classifyProblem(m: ProblemMessage): ProblemSeverity {
  if (m.type === 'mcp:network') {
    if (NOISE_URL_RE.some((re) => re.test(m.url))) return 'noise';
    return 'actionable';
  }
  if (m.type === 'mcp:runtime-error') {
    if (NOISE_RUNTIME_RE.some((re) => re.test(m.message.trim()))) return 'noise';
    return 'actionable';
  }
  // Console: only error-level entries are worth a badge row. Warnings and
  // info are dev chatter (React strict-mode notices, library deprecations).
  return m.level === 'error' ? 'actionable' : 'noise';
}
