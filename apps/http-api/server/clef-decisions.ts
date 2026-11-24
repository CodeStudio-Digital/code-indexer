import { clefPolicyVersion } from './clef-evaluation.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DecisionMode } from '@mcp/company-contracts/designer.js';

// Workers AI Clef Flash list price, checked 2026-11-23. Estimates exclude account discounts.
export const clefInputUsdPerMillion = 0.038;
export const clefDeadlineMs = 800;
export const estimatedClefInputUsd = (tokens: number) => (tokens * clefInputUsdPerMillion) / 1_000_000;

export const decisionSettings = z.object({
  enabled: z.boolean(),
  provider: z.string().max(160),
  defaultMode: z.enum(['off', 'shadow', 'suggest']),
  dailyLimit: z.number().int().min(0).max(10000),
});
export const defaultDecisionSettings = {
  enabled: false,
  provider: '',
  defaultMode: 'off',
  dailyLimit: 100,
} satisfies z.infer<typeof decisionSettings>;
export type DecisionSettings = z.infer<typeof decisionSettings>;
export interface DecisionCandidate {
  id: string;
  description: string;
}
export interface DecisionResult {
  candidate: string | null;
  reason: string;
  tokens: number | null;
  latencyMs: number;
}
interface Connection {
  account: string;
  token: string;
}
const choice = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.number().finite().min(0).max(1)),
  confidence: z.number().min(0).max(1),
});
const envelope = z.object({
  success: z.literal(true),
  result: z.object({
    answers: z.object({ pick: choice }),
    usage: z.object({ input_tokens: z.number().int().nonnegative() }),
  }),
});
export const skipped = (reason: string): DecisionResult => ({
  candidate: null,
  reason,
  tokens: null,
  latencyMs: 0,
});
export function resolveDecisionMode(
  settings: DecisionSettings,
  own: DecisionMode,
  parent: DecisionMode = 'inherit',
) {
  if (!settings.enabled) return 'off';
  return own !== 'inherit' ? own : parent !== 'inherit' ? parent : settings.defaultMode;
}
export function decisionText(value: string) {
  return value
    .replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\|\/)[^"'\r\n]+\1/g, '[path]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s,;]+|(?<![\w/:])\/[\w.~%-]+(?:\/[^\s,;]*)?/g, '[path]')
    .replace(
      /(?:Bearer\s+\S+|\b(?:sk-|ghp_|ghs_|github_pat_|AKIA)[\w.-]{8,}|\b(?:api[_ -]?key|token|password|senha|secret)\s*[:=]\s*\S+)/gi,
      '[redacted]',
    )
    .slice(0, 1200);
}
export class ClefDecisions {
  private readonly cache = new Map<string, { until: number; value: DecisionResult }>();
  private readonly pending = new Map<string, Promise<DecisionResult>>();
  private epoch = new AbortController();
  constructor(
    private readonly transport: typeof fetch = fetch,
    private readonly deadlineMs = clefDeadlineMs,
  ) {}
  invalidate() {
    this.epoch.abort();
    this.epoch = new AbortController();
    this.cache.clear();
    this.pending.clear();
  }
  async decide(input: {
    deadlineAt?: number;
    scope: string;
    kind: 'company' | 'chat';
    text: string;
    candidates: DecisionCandidate[];
    mode: DecisionMode;
    provider: string;
    connection: () => Connection | null;
    reserve: () => boolean;
  }): Promise<DecisionResult> {
    if (input.mode === 'off' || input.mode === 'inherit' || !input.text.trim() || !input.candidates.length)
      return skipped('off');
    const remaining = Math.min(this.deadlineMs, (input.deadlineAt ?? Infinity) - Date.now());
    if (remaining <= 0) return skipped('timeout');
    const candidates = input.candidates.slice(0, 5);
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          clefPolicyVersion,
          input.provider,
          input.scope,
          input.kind,
          decisionText(input.text),
          candidates,
        ]),
      )
      .digest('hex');
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now())
      return { ...cached.value, reason: 'cache', tokens: null, latencyMs: 0 };
    const running = this.pending.get(key);
    if (running) return { ...(await running), tokens: null, latencyMs: 0 };
    if (this.pending.size >= 4) return skipped('capacity');
    const connection = input.connection();
    if (!connection || !/^[a-f0-9]{32}$/i.test(connection.account) || !connection.token)
      return skipped('credentials');
    if (!input.reserve()) return skipped('budget');
    const generation = this.epoch.signal;
    const request = this.query(
      connection,
      input.kind,
      decisionText(input.text),
      candidates,
      generation,
      remaining,
    )
      .then((result) => {
        if (generation.aborted) return skipped('cancelled');
        if (result.reason === 'ok' || result.reason === 'abstain') {
          if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(key, { until: Date.now() + 120000, value: result });
        }
        return result;
      })
      .finally(() => {
        if (this.pending.get(key) === request) this.pending.delete(key);
      });
    this.pending.set(key, request);
    return request;
  }
  private async query(
    connection: Connection,
    kind: string,
    summary: string,
    candidates: DecisionCandidate[],
    generation: AbortSignal,
    remaining: number,
  ): Promise<DecisionResult> {
    const start = Date.now();
    const criteria = Object.fromEntries(
      candidates.map((c, i) => ['r' + i, decisionText(c.description).slice(0, 240)]),
    );
    criteria.unknown = 'The task does not have enough information to select any option.';
    const signal = AbortSignal.any([generation, AbortSignal.timeout(remaining)]);
    try {
      const response = await this.transport(
        'https://api.cloudflare.com/client/v4/accounts/' +
          connection.account +
          '/ai/run/@cf/cloudflare/clef-flash',
        {
          method: 'POST',
          signal,
          redirect: 'error',
          headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'clef-flash',
            state: { surface: kind, task: summary },
            questions: {
              pick: {
                type: 'choice',
                instructions: 'Choose the most suitable candidate for the task.',
                criteria,
              },
            },
          }),
        },
      );
      if (!response.ok) return { ...skipped('http_' + response.status), latencyMs: Date.now() - start };
      const { result } = envelope.parse(await response.json());
      signal.throwIfAborted();
      const ans = result.answers.pick;
      const entries = Object.entries(ans.probabilities).sort((a, b) => b[1] - a[1]);
      if (
        entries.length !== Object.keys(criteria).length ||
        entries.some(([k]) => !Object.hasOwn(criteria, k)) ||
        Math.abs(entries.reduce((total, [, p]) => total + p, 0) - 1) > 0.001 ||
        entries[0][0] !== ans.choice
      )
        return skipped('invalid');
      const good = ans.choice !== 'unknown' && entries[0][1] >= 0.8 && entries[0][1] - entries[1][1] >= 0.15;
      return {
        candidate: good ? candidates[Number(ans.choice.slice(1))].id : null,
        reason: good ? 'ok' : 'abstain',
        tokens: result.usage.input_tokens,
        latencyMs: Date.now() - start,
      };
    } catch {
      return { ...skipped(signal.aborted ? 'timeout' : 'unavailable'), latencyMs: Date.now() - start };
    }
  }
}
