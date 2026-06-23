/**
 * ContextRelevancePipeline factory + convenience entrypoint.
 */
import { CandidatePipeline, type TelemetrySink } from '@mcp/candidate-pipeline';
import {
  AtomicBlockFilter,
  BudgetAwareSelector,
  DecisionMarkerScorer,
  InfoDensityScorer,
  MessageEmbeddingHydrator,
  RecencyScorer,
  RecentTurnsGuard,
  SessionMessagesSource,
  SystemMessageGuard,
  TaskAffinityScorer,
  TaskEmbeddingHydrator,
  WeightedFusionScorer,
  type EmbeddingFn,
  type MessageEmbeddingStore,
} from './stages.js';
import type {
  ContextRelevanceQuery,
  MessageCandidate,
  SessionMessage,
} from './types.js';

export interface ContextRelevancePipelineOptions {
  /** Returns the full ordered list of session messages (oldest → newest). */
  getMessages: () => SessionMessage[];
  embed: EmbeddingFn;
  messageEmbeddingStore: MessageEmbeddingStore;
  telemetry?: TelemetrySink;
}

export function createContextRelevancePipeline(
  options: ContextRelevancePipelineOptions,
): CandidatePipeline<ContextRelevanceQuery, MessageCandidate> {
  return new CandidatePipeline<ContextRelevanceQuery, MessageCandidate>(
    { name: 'context_relevance', telemetry: options.telemetry },
    {
      queryHydrators: [new TaskEmbeddingHydrator(options.embed)],
      sources: [new SessionMessagesSource(options.getMessages)],
      hydrators: [new MessageEmbeddingHydrator(options.embed, options.messageEmbeddingStore)],
      // Filters here are "guards" — they pin messages but never remove them.
      // Real removal happens at the selector stage based on token budget.
      filters: [new SystemMessageGuard(), new RecentTurnsGuard(), new AtomicBlockFilter()],
      scorers: [
        new TaskAffinityScorer(),
        new RecencyScorer(),
        new InfoDensityScorer(),
        new DecisionMarkerScorer(),
        new WeightedFusionScorer(),
      ],
      selector: new BudgetAwareSelector(),
    },
  );
}

export interface CompactResult {
  keptMessages: SessionMessage[];
  droppedMessages: SessionMessage[];
  diag: {
    consideredCount: number;
    keptCount: number;
    droppedCount: number;
    keptTokens: number;
    droppedTokens: number;
    decisionMarkersKept: number;
    decisionMarkersDropped: number;
    durationMs: number;
  };
}

export async function compactSession(
  pipeline: CandidatePipeline<ContextRelevanceQuery, MessageCandidate>,
  query: ContextRelevanceQuery,
): Promise<CompactResult> {
  const result = await pipeline.execute(query);
  const keptTokens = result.selected.reduce((acc, c) => acc + c.tokens, 0);
  const droppedTokens = result.nonSelected.reduce((acc, c) => acc + c.tokens, 0);
  const decisionMarkersKept = result.selected.filter((c) => (c.signals.decisionMarker ?? 0) > 0).length;
  const decisionMarkersDropped = result.nonSelected.filter((c) => (c.signals.decisionMarker ?? 0) > 0).length;
  return {
    keptMessages: result.selected.map((c) => c.message),
    droppedMessages: result.nonSelected.map((c) => c.message),
    diag: {
      consideredCount: result.selected.length + result.nonSelected.length,
      keptCount: result.selected.length,
      droppedCount: result.nonSelected.length,
      keptTokens,
      droppedTokens,
      decisionMarkersKept,
      decisionMarkersDropped,
      durationMs: result.diag.durationMs,
    },
  };
}
