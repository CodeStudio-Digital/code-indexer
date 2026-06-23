/**
 * Helpers for context-relevance scoring.
 *
 * Most logic is heuristic — tuned on session traces. The goal is good
 * enough at "preserve decisions, drop noise"; sophistication can come from
 * shadow traffic + counterfactual data later.
 */
import type { MessageCandidate, SessionMessage } from './types.js';

/**
 * Keywords that strongly suggest the message contains a durable decision,
 * architectural choice, or constraint. Case-insensitive. Multi-word phrases
 * use literal substring match.
 *
 * Order matters: longer phrases first so they don't match shorter ones.
 */
const DECISION_PATTERNS: Array<RegExp> = [
  /\b(decided|deciding) (to|on|that|against)\b/i,
  /\bwe ('re|are) going to\b/i,
  /\bthe approach (is|will be)\b/i,
  /\bthe plan (is|will be)\b/i,
  /\bchose|chosen\b/i,
  /\binstead of\b/i,
  /\bbecause of\b/i,
  /\bthe reason (is|was)\b/i,
  /\bmust (not )?(be|have|use)\b/i,
  /\binvariant\b/i,
  /\bcontract\b/i,
  /\bnever (use|do|call|allow)\b/i,
  /\balways (use|do|prefer)\b/i,
  /\bagreed\b/i,
  /\bconfirmed\b/i,
];

export function detectDecisionMarker(text: string): number {
  // Score = 1.0 for any single hit, +0.2 per additional unique pattern,
  // capped at 1.0. The goal is binary-ish (it's a decision or not).
  let hits = 0;
  for (const re of DECISION_PATTERNS) {
    if (re.test(text)) hits++;
  }
  if (hits === 0) return 0;
  return Math.min(1.0, 0.8 + (hits - 1) * 0.2);
}

/**
 * Information density signal — favor tool-result-laden assistant turns
 * (e.g. "here's the file content" or "here's the search results"). These
 * are expensive to re-fetch and often referenced multiple times.
 */
export function detectInfoDensity(message: SessionMessage): number {
  const text = message.text;
  let score = 0;

  // Tool events are dense by definition.
  if (message.hasToolEvent) score += 0.5;

  // Code blocks signal density.
  const codeBlockCount = (text.match(/```/g) ?? []).length / 2;
  score += Math.min(0.3, codeBlockCount * 0.15);

  // Long messages with structure (lists, tables) are also dense.
  if (text.length > 500) score += 0.1;
  if (/^\s*[-*]\s/m.test(text)) score += 0.05; // bullet list
  if (text.includes('|---')) score += 0.05;    // markdown table

  return Math.min(1.0, score);
}

export function estimateTokens(text: string): number {
  // Rough 4-chars-per-token heuristic. Good enough for budget arithmetic;
  // off by ~10% from tiktoken in either direction, which won't matter when
  // the budget is N thousand tokens.
  return Math.max(1, Math.ceil(text.length / 4));
}

export function toCandidate(message: SessionMessage): MessageCandidate {
  return {
    candidateId: message.id,
    message,
    tokens: message.tokenCount ?? estimateTokens(message.text),
    pinned: message.role === 'system',
    signals: {},
    score: 0,
  };
}
