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

export function wireRunnerEventsToBus(
  runner: CoderRunner,
  bus: CoderRunBus,
  opts: { deferTerminalEvent?: boolean } = {},
): void {
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
  // Periodic heartbeat (and explicit progress notes from cooperating tools)
  // emitted while a tool is in flight. Riding the same bus → bridge highway
  // as everything else means the worker IPC / SSE pipe doesn't need any
  // new plumbing — the dashboard subscribes once and any event resets its
  // StuckBanner timer.
  runner.on('tool_progress', (payload) => {
    publish(bus, 'tool_progress', payload);
  });
  runner.on('operation_started', (payload) => {
    publish(bus, 'operation_started', payload);
  });
  runner.on('operation_progress', (payload) => {
    publish(bus, 'operation_progress', payload);
  });
  runner.on('operation_finished', (payload) => {
    publish(bus, 'operation_finished', payload);
  });
  runner.on('message_complete', (message, usage) => {
    publish(bus, 'message_complete', { message, usage });
  });
  runner.on('plan_posted', (block) => {
    publish(bus, 'plan', block);
  });
  runner.on('spec_posted', (block) => {
    publish(bus, 'spec', block);
  });
  runner.on('question_posted', (block) => {
    publish(bus, 'question', block);
  });
  runner.on('decision_posted', (payload) => {
    publish(bus, 'decision', payload);
  });
  // PermissionGate — a write/execute/admin tool call paused awaiting the
  // user's verdict (modes 'ask'/'auto'). Resolved by POST /tool-approval.
  runner.on('tool_approval_request', (payload) => {
    publish(bus, 'tool_approval_request', payload);
  });
  runner.on('tool_approval_resolved', (payload) => {
    publish(bus, 'tool_approval_resolved', payload);
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
  runner.on('task_updated', (payload) => {
    publish(bus, 'task_updated', payload);
  });
  runner.on('task_run_started', (payload) => {
    publish(bus, 'task_run_started', payload);
  });
  runner.on('task_run_task_started', (payload) => {
    publish(bus, 'task_run_task_started', payload);
  });
  runner.on('task_run_task_progress', (payload) => {
    publish(bus, 'task_run_task_progress', payload);
  });
  runner.on('task_run_task_finished', (payload) => {
    publish(bus, 'task_run_task_finished', payload);
  });
  runner.on('task_run_finished', (payload) => {
    publish(bus, 'task_run_finished', payload);
  });
  runner.on('todos_updated', (payload) => {
    publish(bus, 'todos_updated', payload);
  });
  runner.on('provider_swapped', (provider, model) => {
    publish(bus, 'provider_swapped', { provider, model });
  });
  runner.on('session_agent_changed', (payload) => {
    // Mid-run agent transition (plan→build after submit_plan approval,
    // spec→build after submit_spec, manual switches). Dashboard listens
    // on SSE; AgentPicker updates without a manual refetch.
    publish(bus, 'session_agent_changed', payload);
  });
  runner.on('session_drive_changed', (payload) => {
    // Session Drive write (remember note / auto-captured investigation).
    // Dashboard's Drive panel listens via a DOM bridge and refetches —
    // live updates instead of polling.
    publish(bus, 'session_drive_changed', payload);
  });
  runner.on('diagram_changed', (payload) => {
    // Agent created/updated a .drawio diagram. Dashboard bridges this to a DOM
    // event: the chat panel auto-opens + the embedded editor reloads the XML.
    publish(bus, 'diagram_changed', payload);
  });
  runner.on('diagram_export_request', (payload) => {
    // diagram_export → ask the live embedded editor to render + persist an image.
    publish(bus, 'diagram_export_request', payload);
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
  // workflow tool (Ultra) — live DAG card in the dashboard.
  runner.on('workflow_run_started', (payload) => {
    publish(bus, 'workflow_run_started', payload);
  });
  runner.on('workflow_step_update', (payload) => {
    publish(bus, 'workflow_step_update', payload);
  });
  runner.on('workflow_run_finished', (payload) => {
    publish(bus, 'workflow_run_finished', payload);
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
  runner.on('bt_state_dwell', (payload) => {
    publish(bus, 'bt_state_dwell', payload);
  });
  runner.on('done', (reason, error) => {
    if (error) {
      console.error(`[coder] session run failed (${reason}):`, error.message);
      if (error.stack) console.error(error.stack);
    }
    // Worker runs defer the public terminal frame until runCoder confirms the
    // final assistant/tool transaction is durable. Publishing here lets the
    // renderer refetch one microtask too early and produces a stale transcript.
    if (opts.deferTerminalEvent) return;
    publish(bus, 'done', { reason, error: error?.message });
    markEnded(bus, 'done', { reason, error: error?.message });
  });
}
