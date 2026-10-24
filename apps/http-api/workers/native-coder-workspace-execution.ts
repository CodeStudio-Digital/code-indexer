import { randomUUID } from 'node:crypto';
import type { AgentMessage, ChatUsage } from '@mcp/provider-sdk/wire.js';
import type { PreparedCoderExecution, PreparedCoderOutcome } from '@mcp/code-agent/runtime/prepared-coder-execution.js';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import { evaluateToolInvocation } from '@mcp/code-agent/core/policy.js';
import { createBus, markEnded, publish, type CoderRunBus } from '../coder-bus.js';
import { executeNativeCoder } from './native-coder-execution.js';
import { readNativeWorktreeTransition, readPreviousNativeWorktreeTransition } from './native-worktree-transition-recovery.js';
import { applyNativeCoderWorktreeTransition } from './native-worktree-preparation.js';
import { workerNativeAuthority } from './native-authority-bridge.js';

type ExecutionInput = Parameters<typeof executeNativeCoder>[0];
type BudgetSnapshot = Parameters<NonNullable<ExecutionInput['onWorkspaceBudgetClosed']>>[0];

/** One public chat execution may contain several fully closed native attempts.
 * The new identity is admitted only after the old runtime, children, commands
 * and workspace writer have drained; no attempt mutates its sealed cwd. */
export async function executeNativeCoderWithWorkspaceTransitions(input: ExecutionInput & {
  persistWorktree(path: string | null): Promise<void>;
  loadMessages(): Promise<readonly AgentMessage[]>;
}): Promise<PreparedCoderExecution> {
  if (input.child) throw new Error('Workspace transitions belong to a product root execution');
  const publicBus = input.bus;
  const templateContext = { ...input.prepared.toolContext, ports: { ...input.prepared.toolContext.ports } };
  let prepared = input.prepared;
  let config = input.config;
  let active: PreparedCoderExecution | undefined;
  let activeBus: CoderRunBus | undefined;
  let budget: BudgetSnapshot | undefined;
  let carry: ExecutionInput['workspaceBudget'];
  let started = false;
  let detach = () => {};
  const usage: ChatUsage = { input_tokens: 0, output_tokens: 0 };
  const failBeforeLaunch = async (cause: unknown) => {
    await workerNativeAuthority(input.bridge, input.runId, config.context).terminalizeRun({ context: config.context,
      status: 'failed', commandStatus: 'failed', reason: (cause as { effectOutcome?: string })?.effectOutcome === 'unknown'
        ? 'outcome_unknown' : 'workspace_transition_failed' }).catch(() => undefined);
  };
  try {
  if (prepared.resume) {
    const previous = await readPreviousNativeWorktreeTransition(config, publicBus.ctrl.signal);
    if (previous) {
      const tool = prepared.registry.get(previous.intent.toolName);
      const args = previous.intent.action === 'enter' ? { name: previous.intent.name, branch: previous.intent.branch }
        : { action: previous.intent.action, discard_changes: previous.intent.discardChanges };
      if (!tool || !evaluateToolInvocation(tool, args, { planMode: prepared.preparation.policy.planMode,
        specMode: prepared.preparation.policy.specMode, planApproved: false, specApproved: false, taskScope: null }).allowed) {
        throw new Error('Pending workspace transition is outside the resumed capability or policy scope');
      }
      const cwd = await applyNativeCoderWorktreeTransition(previous.intent, config, input.bridge, input.runId,
        publicBus.ctrl.signal, input.assertOwner, input.persistWorktree);
      prepared = { ...prepared, preparation: { ...prepared.preparation,
        environment: { kind: previous.intent.action === 'enter' ? 'worktree' : 'host', cwd } },
        toolContext: { ...prepared.toolContext, cwd } };
      publish(publicBus, 'session_worktree_changed', { worktree_path: previous.intent.action === 'enter' ? cwd : null, cwd });
    }
  }
  } catch (cause) { await failBeforeLaunch(cause); throw cause; }
  const launch = async () => {
    publicBus.ctrl.signal.throwIfAborted(); input.assertOwner();
    activeBus = createBus(new AbortController());
    const bus = activeBus;
    const abort = () => bus.ctrl.abort(publicBus.ctrl.signal.reason);
    publicBus.ctrl.signal.addEventListener('abort', abort, { once: true });
    if (publicBus.ctrl.signal.aborted) abort();
    bus.subscribers.add(event => { if (event.event !== 'done' && event.event !== 'error') publish(publicBus, event.event, event.data); });
    detach = () => publicBus.ctrl.signal.removeEventListener('abort', abort);
    budget = undefined;
    active = await executeNativeCoder({ ...input, config, prepared, bus,
      workspaceBudget: carry,
      onWorkspaceBudgetClosed: value => { budget = value; input.onWorkspaceBudgetClosed?.(value); } });
    started = true;
  };
  try { await launch(); } catch (cause) { detach(); throw cause; }
  const done = (async (): Promise<PreparedCoderOutcome> => {
    try {
      for (let transitions = 0; ; transitions++) {
        const outcome = await active!.done;
        detach();
        for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
          usage[key] = (usage[key] ?? 0) + (outcome.usage[key] ?? 0);
        }
        if (outcome.reason !== 'workspace_transition') {
          // Preserve the committed facade terminal, including interrupted and
          // error classification, when forwarding the last attempt publicly.
          const terminal = activeBus?.endReason;
          if (!terminal) throw new Error('Native execution closed without its public terminal');
          markEnded(publicBus, terminal.event, terminal.data); return { ...outcome, usage };
        }
        if (transitions >= 8) throw new Error('Workspace transition limit reached; continue explicitly before another switch');
        if (!budget) throw new Error('Workspace transition lacks its closed shared budget');
        carry = remainingBudget(budget);
        publicBus.ctrl.signal.throwIfAborted();
        const { intent } = await readNativeWorktreeTransition(config, publicBus.ctrl.signal);
        const messages = await input.loadMessages();
        const next = await input.bridge.request<ControlPlaneRunContext>('native.workspaceTransition', {
          runId: input.runId, sourceAttemptId: config.context.attemptId, transitionId: intent.id,
        }, { timeoutMs: 60_000 });
        config = { ...config, context: next };
        started = false;
        publicBus.ctrl.signal.throwIfAborted();
        const cwd = await applyNativeCoderWorktreeTransition(intent, config, input.bridge, input.runId,
          publicBus.ctrl.signal, input.assertOwner, input.persistWorktree);
        const preparation = { ...structuredClone(prepared.preparation), agentRunId: next.agentRunId, runnerRunId: randomUUID(),
          capabilitySet: { ...prepared.preparation.capabilitySet, agentRunId: next.agentRunId },
          environment: { kind: intent.action === 'enter' ? 'worktree' as const : 'host' as const, cwd } };
        prepared = { ...prepared, preparation, messages, resume: true, preparedUserContext: undefined,
          toolContext: { ...templateContext, ports: { ...templateContext.ports }, cwd, runtimeGeneration: 'rust_v1',
            controlPlaneParentAgentRunId: next.agentRunId, signal: publicBus.ctrl.signal }, signal: publicBus.ctrl.signal };
        publish(publicBus, 'session_worktree_changed', { worktree_path: intent.action === 'enter' ? cwd : null, cwd });
        await launch();
      }
    } catch (cause) {
      if (!started) {
        await failBeforeLaunch(cause);
      }
      markEnded(publicBus, 'error', { message: cause instanceof Error ? cause.message : String(cause), runtime: 'rust_v1' });
      throw cause;
    } finally { detach(); }
  })();
  void done.catch(() => undefined);
  return { done, transcriptFlushed: done,
    isWaitingForInput: () => active?.isWaitingForInput?.() ?? false,
    isInteractionPending: id => active?.isInteractionPending?.(id) ?? false,
    async cancel(reason) {
      // The active facade journals Stop and revokes its bus before requesting
      // the Control ACK. Aborting the public bus first can tear down an early
      // tool/provider boundary before that cancellation protocol has begun.
      await active?.cancel(reason);
      publicBus.ctrl.abort(reason);
    },
    provideInput: (id, value) => active!.provideInput(id, value),
    resolveInteraction: (id, response) => active!.resolveInteraction(id, response) };
}

function remainingBudget(snapshot: BudgetSnapshot): NonNullable<ExecutionInput['workspaceBudget']> {
  const remaining = (limit: number | undefined, used: number) => {
    if (limit === undefined) return undefined;
    if (used >= limit) throw new Error('Workspace transition cannot reset an exhausted execution budget');
    return limit - used;
  };
  if (Date.now() >= snapshot.execution.executionDeadlineAtUnixMs) throw new Error('Workspace transition execution deadline elapsed');
  return { execution: { ...snapshot.execution, maxTurns: remaining(snapshot.execution.maxTurns, snapshot.usage.turns),
    maxToolCalls: remaining(snapshot.execution.maxToolCalls, snapshot.usage.toolCalls) },
    maxAgents: Math.max(1, snapshot.maxAgents - (snapshot.usage.agents - 1)) };
}
