/**
 * Per-session registry for chat-pipeline executors.
 *
 * One executor per filesystem session UUID; created lazily on the first
 * `POST /pipelines/:pid/start`. Each entry holds:
 *   - the `ChatPipelineExecutor` itself
 *   - a long-lived `CoderRunBus` so the dashboard can `attach` to a
 *     pipeline stream that survives across multiple chat turns
 *   - a teardown function that unsubscribes the executor's internal bus
 *     when the entry is evicted
 *
 * Unlike `activeRuns` (per-turn chat runs), pipeline executors must
 * outlive any individual turn — a pipeline can keep running while the
 * user composes new chat messages on the side.
 */
import type { ChatPipelineExecutor } from '@mcp/code-agent/pipelines/ChatPipelineExecutor.js';
import type { ChatPipelineBus, ChatPipelineEvent } from '@mcp/code-agent/pipelines/lib/eventBus.js';
import type { SessionId } from '@mcp/agent-runtime-contracts';
import { createBus, publish, type CoderRunBus } from '../../../coder-bus.js';
import { publishNotificationRuntimeEvent } from '../../../sse/notification-event-bus.js';

export interface CoderPipelineEntry {
  executor: ChatPipelineExecutor;
  bus: CoderRunBus;
  pipelineBus: ChatPipelineBus;
  /** Unsubscribe the bridge listener that mirrors pipelineBus → CoderRunBus. */
  teardown: () => void;
}

export class CoderPipelineRegistry {
  private readonly entries = new Map<SessionId, CoderPipelineEntry>();

  get(sessionId: SessionId): CoderPipelineEntry | undefined {
    return this.entries.get(sessionId);
  }

  /**
   * Attach an executor + its `ChatPipelineBus`. Wires a bridge that
   * forwards every pipeline event to a fresh long-lived `CoderRunBus`,
   * which the SSE attach endpoint subscribes to. Returns the entry so
   * the caller can immediately publish the bootstrap snapshot if needed.
   */
  register(
    sessionId: SessionId,
    executor: ChatPipelineExecutor,
    pipelineBus: ChatPipelineBus,
  ): CoderPipelineEntry {
    const existing = this.entries.get(sessionId);
    if (existing) return existing;

    const bus = createBus(new AbortController());
    const teardown = pipelineBus.subscribe((event: ChatPipelineEvent) => {
      const data = {
        coderSessionId: event.coderSessionId,
        executionId: event.executionId,
        pipelineId: event.pipelineId,
        ts: event.ts,
        ...(event.payload ?? {}),
      };
      // Forward as a standard SSE event under the same name; the
      // dashboard's agent-stream handlers register matching keys.
      publish(bus, event.name, data);
      publishNotificationRuntimeEvent({
        kind: 'coder',
        sessionId,
        event: event.name,
        data,
      });
    });

    const entry: CoderPipelineEntry = { executor, bus, pipelineBus, teardown };
    this.entries.set(sessionId, entry);
    return entry;
  }

  /** Drop the entry and stop forwarding events. The executor itself is left
   *  alone — callers in the abort/dispose path are responsible for terminal
   *  state on the executor before evicting. */
  evict(sessionId: SessionId): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    try {
      entry.teardown();
    } catch {
      // best-effort
    }
    this.entries.delete(sessionId);
    return true;
  }
}
