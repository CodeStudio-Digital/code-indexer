/**
 * Wires a `CoderRunner`'s event stream onto a `CoderRunBus`.
 *
 * Extracted from `routes/coder/state.ts` so both the legacy in-process
 * path AND the new `coder-worker.ts` (P17) can call it. Same shape,
 * one source of truth — keeps the SSE event vocabulary identical
 * between transports.
 */
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import {
  publish,
  markEnded,
  type CoderRunBus,
} from '../coder-bus.js';

export function wireRunnerEventsToBus(runner: CoderRunner, bus: CoderRunBus): void {
  runner.on('text_delta', (text) => {
    publish(bus, 'text', { text });
  });
  runner.on('thinking_delta', (text) => {
    publish(bus, 'thinking', { text });
  });
  runner.on('tool_call_start', (id, name, input) => {
    publish(bus, 'tool_call_start', { id, name, input });
  });
  runner.on('tool_call_result', (id, name, result, durationMs) => {
    publish(bus, 'tool_call_result', { id, name, result, duration_ms: durationMs });
  });
  runner.on('message_complete', (message, usage) => {
    publish(bus, 'message_complete', { message, usage });
  });
  runner.on('plan_posted', (block) => {
    publish(bus, 'plan', block);
  });
  runner.on('question_posted', (block) => {
    publish(bus, 'question', block);
  });
  runner.on('tasks_posted', (payload) => {
    publish(bus, 'tasks_posted', payload);
  });
  runner.on('task_started', (payload) => {
    publish(bus, 'task_started', payload);
  });
  runner.on('task_finished', (payload) => {
    publish(bus, 'task_finished', payload);
  });
  runner.on('todos_updated', (payload) => {
    publish(bus, 'todos_updated', payload);
  });
  runner.on('provider_swapped', (provider, model) => {
    publish(bus, 'provider_swapped', { provider, model });
  });
  runner.on('fallback_activated', (payload) => {
    publish(bus, 'fallback_activated', payload);
  });
  runner.on('history_compacted', (payload) => {
    publish(bus, 'history_compacted', payload);
  });
  runner.on('agents_group_start', (payload) => {
    publish(bus, 'agents_group_start', payload);
  });
  runner.on('agent_progress', (payload) => {
    publish(bus, 'agent_progress', payload);
  });
  runner.on('agents_group_end', (payload) => {
    publish(bus, 'agents_group_end', payload);
  });
  runner.on('auto_continue', (count, max) => {
    publish(bus, 'auto_continue', { count, max });
  });
  runner.on('context_status', (payload) => {
    publish(bus, 'context_status', payload);
  });
  runner.on('run_started', (payload) => {
    publish(bus, 'run_started', payload);
  });
  runner.on('provider_call', (payload) => {
    publish(bus, 'provider_call', payload);
  });
  runner.on('tool_batch', (payload) => {
    publish(bus, 'tool_batch', payload);
  });
  runner.on('blocked', (payload) => {
    publish(bus, 'blocked', payload);
  });
  runner.on('tool_loop_intervention', (payload) => {
    publish(bus, 'tool_loop_intervention', payload);
  });
  runner.on('quality_watchdog_alert', (payload) => {
    publish(bus, 'quality_watchdog_alert', payload);
  });
  runner.on('done', (reason, error) => {
    if (error) {
      console.error(`[coder] session run failed (${reason}):`, error.message);
      if (error.stack) console.error(error.stack);
    }
    publish(bus, 'done', { reason, error: error?.message });
    markEnded(bus, 'done', { reason, error: error?.message });
  });
}
