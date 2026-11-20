/**
 * Budget of a child-agent session run, the same one an in-process child of
 * the profile gets: a hard tool-call cap, a wall-clock limit, the stall
 * watchdog, a one-shot warning at 80% of either cap, and a salvage summary
 * when the run is cut off. Attached only to child-agent sessions.
 */
import type { AgentMessage, ChatUsage } from '../core/messages.js';
import type { ChatProvider } from '../providers/adapter.js';
import { buildHardBudgetNudge } from '../tools/implement-subagent.js';
import { createSubagentMonitor } from '../tools/subagent-monitor.js';
import { buildSubagentSalvageSummary } from '../tools/subagent-salvage.js';
import type { ChildAgentRun } from './child-agent-run.js';

/** The part of CoderRunner the budget drives. */
export interface BudgetedRunner {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  abort(): void;
  setSystemPromptForNextTurn(systemPrompt: string): void;
}

export interface ChildAgentBudget {
  /** Why the run was cut off, or null when it ended on its own. */
  cutoff(): string | null;
  toolCalls(): number;
  /** The summary that replaces the final answer of a cut-off run. */
  salvage(provider: ChatProvider, messages: AgentMessage[], signal?: AbortSignal): Promise<{ text: string; usage: ChatUsage }>;
  cleanup(): void;
}

export function attachChildAgentBudget(
  runner: BudgetedRunner,
  run: ChildAgentRun,
  basePrompt: () => string,
  options: {
    /**
     * Cancels in-flight work (the provider stream, a running tool): the
     * runner's own abort only stops between steps. runCoder passes the abort
     * of a signal combined into the run's tool context.
     */
    onCutoff?: (message: string) => void;
    now?: () => number;
  } = {},
): ChildAgentBudget {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const { maxToolCalls, timeoutMs } = run.limits;
  let toolCalls = 0;
  let turn = 0;
  let lastToolName: string | undefined;
  let nudged = false;
  let cutoff: string | null = null;

  const fail = (message: string): void => {
    if (cutoff) return;
    cutoff = message;
    try { runner.abort(); } catch { /* the runner may already be terminal */ }
    options.onCutoff?.(message);
  };
  const monitor = createSubagentMonitor({
    limits: run.limits,
    startedAt,
    getToolCallCount: () => toolCalls,
    getTurn: () => turn,
    getLastToolName: () => lastToolName,
    onFail: (message) => fail(message),
  });
  // The watchdog reports through onFail; its promise only mirrors that.
  monitor.promise.catch(() => undefined);

  const listeners: Array<[string, (...args: any[]) => void]> = [
    ['turn_start', (next: unknown) => {
      turn = typeof next === 'number' ? next : turn + 1;
      monitor.recordVisual('turn', `turn ${turn}`);
      if (nudged) return;
      const elapsedMs = now() - startedAt;
      const toolsNear = maxToolCalls > 0 && toolCalls >= Math.ceil(maxToolCalls * 0.8);
      const timeNear = timeoutMs > 0 && elapsedMs >= timeoutMs * 0.8;
      if (!toolsNear && !timeNear) return;
      nudged = true;
      runner.setSystemPromptForNextTurn(basePrompt() + buildHardBudgetNudge({
        trigger: toolsNear ? 'tools' : 'time', toolCalls, maxToolCalls, elapsedMs, timeoutMs,
      }));
    }],
    ['provider_call', (payload: { provider?: string; model?: string } = {}) => {
      monitor.recordProviderCall(payload.provider ?? 'provider', payload.model ?? 'model');
    }],
    ['text_delta', () => monitor.recordProviderDelta('text_delta', 'streaming text', false)],
    ['thinking_delta', () => monitor.recordProviderDelta('thinking_delta', 'thinking', false)],
    ['tool_call_start', (_id: string, name: string) => {
      lastToolName = name;
      monitor.recordSemantic('tool_call_start', `${name} started`, { toolName: name, lastToolName: name });
    }],
    ['tool_progress', (payload: { name: string; note?: string }) => {
      lastToolName = payload.name;
      monitor.recordToolProgress(payload.name, payload.note ?? payload.name);
    }],
    ['tool_call_result', (_id: string, name: string) => {
      toolCalls++;
      lastToolName = name;
      monitor.recordToolResult(name);
      if (maxToolCalls > 0 && toolCalls >= maxToolCalls) fail(`task tool limit reached (${toolCalls}/${maxToolCalls})`);
    }],
  ];
  for (const [event, listener] of listeners) runner.on(event, listener);

  return {
    cutoff: () => cutoff,
    toolCalls: () => toolCalls,
    salvage: (provider, messages, signal) => buildSubagentSalvageSummary({
      provider,
      label: run.profile.defaultLabel,
      reason: cutoff ?? 'stopped',
      messages,
      toolCallCount: toolCalls,
      lastToolName,
      collected: { memos: [], snapshots: [], boardPosts: [] },
      sandboxViolations: [],
      parentSignal: signal,
    }),
    cleanup() {
      monitor.cleanup();
      for (const [event, listener] of listeners) runner.off(event, listener);
    },
  };
}
