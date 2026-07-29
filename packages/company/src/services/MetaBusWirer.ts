/**
 * MetaBusWirer — forwards runner-level events to the orchestrator's
 * meta-bus, enveloped as `agent_event` so the dashboard can demux them
 * by agent role/id.
 *
 * Declarative event list keeps the Open/Closed principle for single-payload
 * events. Positional runner events are normalized below into stable named
 * payloads before crossing the meta-bus boundary.
 */

import type { EventEmitter } from 'node:events';
import type { RunCoderHandle } from '@mcp/code-agent/index.js';
import type { IMetaBusPublisher, IMetaBusWirer } from '@mcp/company/services/ports.js';

/**
 * Runner-emitted events that map 1:1 to `agent_event` envelopes on the
 * meta-bus. Order is irrelevant — listed grouped by concern for readability.
 */
export const FORWARDED_EVENTS: readonly string[] = [
  // Turn streaming
  'text_delta', 'tool_call_start', 'tool_call_result', 'message_complete',
  // Goal mutation durability
  'goal_mutations_persisted', 'goal_mutations_persistence_failed',
  // Live activity pill — `provider_call` gives the `provider:model` + "calling
  // provider with N tools" line; `tool_progress` refines elapsed/note; the
  // `operation_*` trio covers nested sub-agent / task ops. The dashboard
  // builds a per-agent activity block from these (mirrors the chat pill).
  'provider_call', 'tool_progress',
  'operation_started', 'operation_progress', 'operation_finished',
  // Plan / question / tasks
  'plan_posted', 'question_posted', 'tasks_posted',
  'task_started', 'task_finished',
  // Session-level metadata
  'todos_updated', 'provider_swapped', 'fallback_activated', 'history_compacted',
  // Parallel agents (legacy sub-agent tool)
  'agents_group_start', 'agent_progress', 'agents_group_end',
  // Flow control
  'auto_continue', 'context_status',
];

function normalizeEventData(event: string, args: unknown[]): unknown {
  switch (event) {
    case 'text_delta':
      return { text: args[0] };
    case 'tool_call_start':
      return { id: args[0], name: args[1], input: args[2] };
    case 'tool_call_result': {
      const [id, name, result, durationMs] = args;
      const isError = typeof result === 'object'
        && result !== null
        && 'isError' in result
        && (result as { isError?: unknown }).isError === true;
      const awaitsGoalPersistence =
        !isError && (name === 'create_goal' || name === 'update_goal');
      return {
        id,
        name,
        result,
        duration_ms: durationMs,
        status: isError ? 'error' : awaitsGoalPersistence ? 'running' : 'done',
        ...(awaitsGoalPersistence ? { persistence: 'pending' } : {}),
      };
    }
    case 'message_complete':
      return { message: args[0], usage: args[1] };
    default:
      return args.length === 1 ? args[0] : args;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MetaBusWirer implements IMetaBusWirer {
  private readonly wiredRunners = new WeakMap<
    object,
    { eventsWired: boolean; terminalWired: boolean }
  >();

  constructor(private readonly publisher: IMetaBusPublisher) {}

  wire(handle: RunCoderHandle, role: string, agentRunId: string): void {
    const emitter = handle.runner as unknown as EventEmitter;
    const runnerKey = handle.runner as unknown as object;
    const wiring = this.wiredRunners.get(runnerKey) ?? {
      eventsWired: false,
      terminalWired: false,
    };
    this.wiredRunners.set(runnerKey, wiring);

    if (!wiring.eventsWired) {
      wiring.eventsWired = true;
      for (const evt of FORWARDED_EVENTS) {
        emitter.on(evt, (...args: unknown[]) => {
          this.publisher.publish('agent_event', {
            agent: role,
            agentRunId,
            event: evt,
            data: normalizeEventData(evt, args),
          });
        });
      }
    }

    // Company installs turn listeners through onRunnerReady before runCoder
    // can return a complete handle. That first call intentionally stops here;
    // the lifecycle calls wire() again with the full handle to attach only the
    // durable terminal boundary (the WeakMap prevents duplicate stream rows).
    const transcriptFlushed = (
      handle as Partial<Pick<RunCoderHandle, 'transcriptFlushed'>>
    ).transcriptFlushed;
    if (
      wiring.terminalWired
      || !transcriptFlushed
      || typeof transcriptFlushed.then !== 'function'
    ) {
      return;
    }
    wiring.terminalWired = true;

    // Runner completion precedes the final transcript/goal transaction. The
    // Company surface must therefore publish its terminal event from the
    // durable boundary, not from runner.done, or a provisional green goal can
    // be followed by a failed commit after the UI already declared success.
    void transcriptFlushed.then(
      (outcome) => {
        this.publisher.publish('agent_event', {
          agent: role,
          agentRunId,
          event: 'done',
          data: { reason: outcome.reason, error: outcome.error },
        });
      },
      (error: unknown) => {
        this.publisher.publish('agent_event', {
          agent: role,
          agentRunId,
          event: 'done',
          data: { reason: 'error', error: errorMessage(error) },
        });
      },
    );
  }
}
