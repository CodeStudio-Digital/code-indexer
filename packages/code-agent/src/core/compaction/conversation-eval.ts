import type { CompactionSummaryV3 } from '@mcp/code-agent/core/summarizer.js';

export interface PlantedConversationFact {
  id: string;
  /** Any one phrase is sufficient evidence that the critical fact survived. */
  acceptedPhrases: readonly string[];
}

export interface RecallEvalCase {
  query: string;
  expectedChapterId: number;
  rankedChapterIds: readonly number[];
}

export interface ConversationCompactionEvalResult {
  retentionByCheckpoint: Array<{ checkpoint: number; retained: number; total: number; ratio: number }>;
  minimumRetention: number;
  recallAt3: number;
  passes: boolean;
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function searchableSummary(summary: CompactionSummaryV3): string {
  return normalize(JSON.stringify({ chapter: summary.chapter, resume: summary.resume }));
}

export function criticalRetention(
  summary: CompactionSummaryV3,
  facts: readonly PlantedConversationFact[],
): { retained: number; total: number; ratio: number } {
  const haystack = searchableSummary(summary);
  const retained = facts.filter((fact) => fact.acceptedPhrases.some(
    (phrase) => haystack.includes(normalize(phrase)),
  )).length;
  return {
    retained,
    total: facts.length,
    ratio: facts.length > 0 ? retained / facts.length : 1,
  };
}

export function recallAtK(cases: readonly RecallEvalCase[], k: number): number {
  if (cases.length === 0) return 1;
  const cap = Math.max(1, Math.trunc(k));
  const hits = cases.filter((item) => (
    item.rankedChapterIds.slice(0, cap).includes(item.expectedChapterId)
  )).length;
  return hits / cases.length;
}

/** Acceptance gate from the rollout plan: retention >=95%, recall@3 >=90%. */
export function evaluateConversationCompaction(args: {
  checkpoints: ReadonlyArray<{ checkpoint: number; summary: CompactionSummaryV3 }>;
  facts: readonly PlantedConversationFact[];
  recallCases: readonly RecallEvalCase[];
  retentionGate?: number;
  recallGate?: number;
}): ConversationCompactionEvalResult {
  const retentionByCheckpoint = args.checkpoints.map(({ checkpoint, summary }) => ({
    checkpoint,
    ...criticalRetention(summary, args.facts),
  }));
  const minimumRetention = retentionByCheckpoint.length > 0
    ? Math.min(...retentionByCheckpoint.map((item) => item.ratio))
    : 1;
  const recallAt3 = recallAtK(args.recallCases, 3);
  const passes = minimumRetention >= (args.retentionGate ?? 0.95)
    && recallAt3 >= (args.recallGate ?? 0.9);
  return { retentionByCheckpoint, minimumRetention, recallAt3, passes };
}
