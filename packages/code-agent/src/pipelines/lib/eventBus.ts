/**
 * Minimal event emitter for chat-pipeline lifecycle events. The chat
 * executor publishes one of these events at every state transition; in
 * PR-3 this is bridged into `coder-bus` (the chat SSE pump) so the
 * dashboard can show runtime status. In tests, callers attach a sink
 * directly via `subscribe()`.
 *
 * Intentionally tiny: no wildcards, no priority, no async dispatch. The
 * shape mirrors `PipelineExecutor`'s `IMetaBusPublisher.publish`.
 */

export type ChatPipelineEventName =
  | 'pipeline_started'
  | 'pipeline_node_started'
  | 'pipeline_node_completed'
  | 'pipeline_node_failed'
  | 'pipeline_paused'
  | 'pipeline_resumed'
  | 'pipeline_completed'
  | 'pipeline_aborted'
  | 'pipeline_failed';

export interface ChatPipelineEvent {
  name: ChatPipelineEventName;
  /** Owner chat session — used as the SSE bus key in PR-3. */
  coderSessionId: number;
  /** `pipeline_executions.id`. */
  executionId: number;
  /** `pipelines.id`. */
  pipelineId: number;
  /** Optional payload — node id, outcome, error message, etc. */
  payload?: Record<string, unknown>;
  /** Wall-clock at publish time, for transcripts/replay. */
  ts: string;
}

export type ChatPipelineSink = (event: ChatPipelineEvent) => void;

export interface ChatPipelineBus {
  publish(event: Omit<ChatPipelineEvent, 'ts'>): void;
  subscribe(sink: ChatPipelineSink): () => void;
}

export function createChatPipelineBus(): ChatPipelineBus {
  const sinks = new Set<ChatPipelineSink>();
  return {
    publish(event) {
      const fullEvent: ChatPipelineEvent = { ...event, ts: new Date().toISOString() };
      for (const sink of sinks) {
        try {
          sink(fullEvent);
        } catch {
          // Best-effort: a broken sink must not break the executor.
        }
      }
    },
    subscribe(sink) {
      sinks.add(sink);
      return () => {
        sinks.delete(sink);
      };
    },
  };
}
