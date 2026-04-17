/**
 * MetaBusWirer — forwards runner-level events to the orchestrator's
 * meta-bus, enveloped as `agent_event` so the dashboard can demux them
 * by agent role/id.
 *
 * Declarative event list keeps the Open/Closed principle: add a new
 * runner event name to `FORWARDED_EVENTS` and it flows to the dashboard
 * with no other changes.
 */

import type { EventEmitter } from 'node:events';
import type { RunCoderHandle } from '../../index.js';
import type { IMetaBusPublisher, IMetaBusWirer } from './ports.js';

/**
 * Runner-emitted events that map 1:1 to `agent_event` envelopes on the
 * meta-bus. Order is irrelevant — listed grouped by concern for readability.
 */
export const FORWARDED_EVENTS: readonly string[] = [
  // Turn streaming
  'text_delta', 'tool_call_start', 'tool_call_result', 'message_complete',
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

export class MetaBusWirer implements IMetaBusWirer {
  constructor(private readonly publisher: IMetaBusPublisher) {}

  wire(handle: RunCoderHandle, role: string, agentRunId: number): void {
    const emitter = handle.runner as unknown as EventEmitter;

    for (const evt of FORWARDED_EVENTS) {
      emitter.on(evt, (...args: unknown[]) => {
        this.publisher.publish('agent_event', {
          agent: role,
          agentRunId,
          event: evt,
          data: args.length === 1 ? args[0] : args,
        });
      });
    }

    // `done` has a distinct payload shape (reason + optional error) — kept
    // separate so the envelope always matches what the dashboard expects.
    handle.runner.on('done', (reason: string, error?: Error) => {
      this.publisher.publish('agent_event', {
        agent: role,
        agentRunId,
        event: 'done',
        data: { reason, error: error?.message },
      });
    });
  }
}
