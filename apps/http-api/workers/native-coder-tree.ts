import { NativeRunTreeBudget, type NativeTreeConsumptionPort, type VerifiedRuntimePackage } from '@mcp/agent-runtime-host';
import type { PreparedCoderInputs, PreparedCoderOutcome } from '@mcp/code-agent/runtime/prepared-coder-execution.js';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import type { NativeChildRequest, NativeChildAdmission } from '../native-child-admission.js';
import type { NativeProductAuthority } from '../native-attempt-runtime.js';
import type { NativeWorkspaceLease } from '../native-workspace-leases.js';
import type { NativeWorkspaceLeaseGroup } from '../native-workspace-lease-group.js';
import { createBus, clearReplayBuffer, publish, type CoderRunBus, type BufferedEvent } from '../coder-bus.js';
import { NativeTreeInteractions } from './native-tree-interactions.js';
import { nativeCoderWorkspaceAccess } from './native-coder-catalog.js';
import { nativeCoderExecutionBudget, type NativeCoderExecutionBudget } from './native-coder-budget.js';
import { executeNativeCoder } from './native-coder-execution.js';
import { workerNativeAuthority } from './native-authority-bridge.js';
import { nativeChildTranscriptRef } from '../native-child-storage.js';
import { readNativeChildTranscript } from '../native-child-transcript.js';
import { NativeChildContinuation } from './native-child-continuation.js';
import { NativeTreeScheduler } from './native-tree-scheduler.js';
import { NativeTreeResources, type NativeTreeResourceLimits } from './native-tree-resources.js';
import { NativeTreeInventory } from './native-tree-inventory.js';
import type { AgentTreeEvent, AgentTreeReconciliation } from '@mcp/code-agent/ports/agent-tree-port.js';
import type { NativeChildCompletionAuthority } from '../native-child-reference-authority.js';
import { reconcileNativeChildJournal } from '../native-child-reconciliation.js';
import { NativeTreeMailbox } from './native-tree-mailbox.js';
import { NativeTreeJobs } from './native-tree-jobs.js';
import type { ProviderContextPreparationPort } from '@mcp/agent-runtime-host';
import type { AgentTreeMessageRequest, AgentTreeMessageReceipt } from '@mcp/code-agent/ports/agent-tree-port.js';
import type { ToolResult } from '@mcp/code-agent/core/tool.js';
import type { NativeTreeInboxEntry } from '../native-tree-inbox.js';
export { nativeChildSessionRoot, nativeChildTranscriptRef } from '../native-child-storage.js';

export interface NativeCoderTreeOptions {
  readonly maxAgents: number;
  readonly maxDepth: number;
  readonly maxParallel: number;
  readonly resources?: NativeTreeResourceLimits;
  readonly ready?: (owner: NativeCoderTreeOwner) => void;
}

/** Shared authority for the whole native development tree. */
export class NativeCoderSharedTree {
  readonly budget: NativeRunTreeBudget;
  readonly resources: NativeTreeResources;
  readonly inventory: NativeTreeInventory;
  readonly mailbox: NativeTreeMailbox;
  readonly continuations = new Map<string, { parent: string; run: (text: string, signal: AbortSignal, invocationId: string) => Promise<ToolResult> }>();
  private active = 0;
  constructor(readonly root: ControlPlaneRunContext, execution: NativeCoderExecutionBudget,
    readonly options: NativeCoderTreeOptions, signal: AbortSignal) {
    if (!Number.isInteger(options.maxParallel) || options.maxParallel < 1 || options.maxParallel > 8) throw new Error('Invalid native tree parallel process bound');
    this.budget = new NativeRunTreeBudget(root, { ...execution, maxAgents: options.maxAgents, maxDepth: options.maxDepth,
      deadlineAtUnixMs: execution.executionDeadlineAtUnixMs }, signal);
    this.options = Object.freeze({ ...options });
    this.inventory = new NativeTreeInventory(root.agentRunId);
    this.mailbox = new NativeTreeMailbox(this.inventory);
    this.resources = new NativeTreeResources(signal, options.resources);
  }
  reserveProcess(): () => void {
    if (this.active >= this.options.maxParallel) throw new Error('Native tree parallel process budget exhausted');
    this.active++;
    let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }
}

export class NativeCoderChildExecution {
  private claimed = false;
  get wasClaimed(): boolean { return this.claimed; }
  constructor(readonly admission: NativeChildAdmission, readonly shared: NativeCoderSharedTree,
    readonly leases: NativeWorkspaceLeaseGroup, readonly lease: NativeWorkspaceLease,
    readonly executionBudget: NativeCoderExecutionBudget, readonly consumption: NativeTreeConsumptionPort,
    readonly continuation?: NativeChildContinuation) {}
  claim(context: ControlPlaneRunContext, root: string): void {
    if (this.claimed || JSON.stringify(context) !== JSON.stringify(this.admission.context)
      || this.lease.ownerAgentRunId !== context.agentRunId || this.lease.attemptId !== context.attemptId
      || this.lease.root.toLowerCase() !== root.toLowerCase() || !this.lease.parentLeaseId) {
      throw new Error('Native child execution lacks its unused delegated workspace reservation');
    }
    this.claimed = true;
  }
  async releaseBeforeClaim(): Promise<void> {
    if (this.claimed) return;
    await this.leases.release(this.lease, async () => {}); this.consumption.close();
  }
}

export interface NativeChildExecutionResult {
  readonly admission: NativeChildAdmission;
  readonly outcome: PreparedCoderOutcome;
  readonly finalText: string;
  readonly transcriptRef: string;
}

type ExecutionInput = Parameters<typeof executeNativeCoder>[0];

/** Owns actual child execution promises, not transport ACKs. Parent shutdown
 * cancels and drains every admitted child before releasing workspace authority. */
export class NativeCoderTreeOwner {
  readonly interactions: NativeTreeInteractions;
  readonly scheduler: NativeTreeScheduler;
  private readonly jobs: NativeTreeJobs;
  get lifetimeSignal() { return this.input.bus.ctrl.signal; }
  private readonly pending = new Map<Promise<NativeChildExecutionResult>, CoderRunBus>();
  private closing = false;
  constructor(private readonly input: ExecutionInput, private readonly store: NativeProductAuthority,
    readonly shared: NativeCoderSharedTree, private readonly leases: NativeWorkspaceLeaseGroup,
    private readonly lease: NativeWorkspaceLease, private readonly quiesce: () => Promise<void>,
    private readonly runtimePackage: VerifiedRuntimePackage) {
    this.interactions = new NativeTreeInteractions((event, data) => publish(input.bus, event, data));
    this.scheduler = new NativeTreeScheduler(shared.options.maxParallel);
    const persist = (key: string, payload: unknown) => {
      input.assertOwner(); input.bus.ctrl.signal.throwIfAborted();
      return store.commitRuntimeRequest(input.config.context, key, payload);
    };
    this.jobs = new NativeTreeJobs(persist, input.bus.ctrl.signal);
    shared.mailbox.register(input.config.context.agentRunId, persist);
    shared.inventory.update(input.config.context.agentRunId, { provider: input.prepared.preparation.provider,
      model: input.prepared.preparation.model });
  }

  runPrepared(request: NativeChildRequest,
    prepare: (admission: NativeChildAdmission, signal: AbortSignal) => PreparedCoderInputs | Promise<PreparedCoderInputs>,
    observe?: (event: BufferedEvent) => void, signal?: AbortSignal): Promise<NativeChildExecutionResult> {
    this.input.assertOwner(); this.input.bus.ctrl.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (this.closing) return Promise.reject(new Error('Native child owner is closing'));
    const releaseSlot = this.shared.reserveProcess();
    const bus = createBus(new AbortController());
    const abort = () => bus.ctrl.abort(this.input.bus.ctrl.signal.reason);
    this.input.bus.ctrl.signal.addEventListener('abort', abort, { once: true });
    const cancelChild = () => bus.ctrl.abort(signal?.reason);
    signal?.addEventListener('abort', cancelChild, { once: true });
    let prompts: ReturnType<NativeTreeInteractions['child']> | undefined;
    let finalText = '';
    const collect = (event: BufferedEvent) => {
      if (admission) {
        if (['tool_approval_request', 'question', 'decision', 'tasks_posted', 'plan', 'spec', 'budget_request'].includes(event.event)) {
          this.shared.inventory.update(admission.context.agentRunId, { status: 'waiting' });
        } else if (event.event === 'tool_call_result') this.shared.inventory.update(admission.context.agentRunId, { status: 'running' });
      }
      try { prompts?.forward(event); } catch (cause) { bus.ctrl.abort(cause); }
      if (event.event === 'message_complete') {
        const data = event.data as { message?: { content?: { type: string; text?: string }[] } };
        let text = '';
        for (const block of data.message?.content ?? []) if (block.type === 'text' && block.text) {
          text = (text + block.text.slice(0, 16_384)).slice(0, 16_384);
        }
        if (text) finalText = text;
      }
      observe?.(event);
    };
    bus.subscribers.add(collect);
    let reservation: NativeCoderChildExecution | undefined;
    let continuation: NativeChildContinuation | undefined;
    let admission: NativeChildAdmission | undefined;
    let launchCalled = false;
    const done = Promise.resolve().then(async () => {
      bus.ctrl.signal.throwIfAborted();
      admission = await this.store.admitNativeChild(this.input.config.context, request);
      if (admission.kind !== 'reserved') throw new Error('Native child admission already exists; reconcile instead of relaunching');
      this.shared.inventory.admit({ agentRunId: admission.context.agentRunId,
        parentAgentRunId: this.input.config.context.agentRunId, role: request.role, provider: request.provider, model: request.model });
      prompts = this.interactions.child(admission.context.attemptId, admission.context.agentRunId);
      const consumption = this.shared.budget.childPort(admission);
      try {
        const prepared = await prepare(admission, bus.ctrl.signal);
        bus.ctrl.signal.throwIfAborted();
        if (request.resumeFromRef) {
          const resolveSource = () => this.input.bridge.request<ControlPlaneRunContext>('native.authority', {
            runId: this.input.runId, agentRunId: this.input.config.context.agentRunId,
            operation: { kind: 'childTranscript', reference: request.resumeFromRef },
          }, { timeoutMs: 30_000 });
          const context = await resolveSource();
          const inbox = await this.input.bridge.request<NativeTreeInboxEntry[]>('native.authority', {
            runId: this.input.runId, agentRunId: this.input.config.context.agentRunId,
            operation: { kind: 'continuationInbox', source: { reference: request.resumeFromRef } },
          }, { timeoutMs: 30_000 });
          continuation = await NativeChildContinuation.open({ context, rootPath: this.input.config.sessionRoot,
            inbox,
            allowCompleted: request.continuationPurpose === 'followup',
            runtimePackage: this.runtimePackage, provider: request.provider, model: request.model, signal: bus.ctrl.signal,
            assertOwner: async () => {
              this.input.assertOwner(); bus.ctrl.signal.throwIfAborted();
              if (JSON.stringify(await resolveSource()) !== JSON.stringify(context)) throw new Error('Native child resume authority changed');
              this.input.assertOwner(); bus.ctrl.signal.throwIfAborted();
            } });
        }
        const budget = nativeCoderExecutionBudget({ maxTurns: prepared.maxTurns,
          policy: prepared.preparation.policy.runtime?.execution, executorExpiresAt: new Date(request.deadlineAtUnixMs).toISOString() });
        const deadline = Math.min(request.deadlineAtUnixMs, this.shared.budget.limits.deadlineAtUnixMs, budget.deadlineAtUnixMs);
        const executionBudget = { ...budget, deadlineAtUnixMs: deadline,
          executionDeadlineAtUnixMs: Math.min(deadline - 1000, budget.executionDeadlineAtUnixMs) };
        const workspace = await this.leases.delegate(this.lease, { root: this.lease.root,
          ownerAgentRunId: admission.context.agentRunId, attemptId: admission.context.attemptId,
          access: nativeCoderWorkspaceAccess(prepared.registry.list(), true), expiresAtUnixMs: deadline,
          assertOwner: async () => { this.input.assertOwner(); bus.ctrl.signal.throwIfAborted(); } }, this.quiesce);
        reservation = new NativeCoderChildExecution(admission, this.shared, workspace.group, workspace.lease, executionBudget, consumption, continuation);
        bus.ctrl.signal.throwIfAborted();
        launchCalled = true;
        this.shared.inventory.update(admission.context.agentRunId, { status: 'running' });
        const execution = await executeNativeCoder({ ...this.input, bus, tree: undefined, child: reservation,
          workspaceBudget: undefined, onWorkspaceBudgetClosed: undefined,
          config: { ...this.input.config, context: admission.context }, prepared });
        this.shared.inventory.update(admission.context.agentRunId, { is_alive: true });
        prompts.attach(execution);
        const outcome = await execution.done;
        this.shared.inventory.update(admission.context.agentRunId, { status: outcome.reason === 'completed' ? 'completed'
          : ['aborted', 'max_turns', 'max_tool_calls', 'max_wall_ms'].includes(outcome.reason) ? 'interrupted' : 'failed', is_alive: false });
        releaseSlot();
        return { admission, outcome, finalText, transcriptRef: nativeChildTranscriptRef(admission.context, this.shared.root.attemptId) };
      } finally { consumption.close(); }
    }).catch(async cause => {
      await reservation?.releaseBeforeClaim();
      if (!launchCalled || !reservation?.wasClaimed) {
        releaseSlot();
      }
      if (admission?.kind === 'reserved') {
        this.shared.inventory.update(admission.context.agentRunId, { status: 'failed', is_alive: launchCalled ? undefined : false });
        const childStore = workerNativeAuthority(this.input.bridge, this.input.runId, admission.context);
        const state = await childStore.getAttemptState(admission.context, false);
        if (state.run.status === 'starting' || state.run.status === 'running') await childStore.terminalizeRun({ context: admission.context,
          status: 'failed', commandStatus: 'failed', reason: launchCalled ? 'native_child_execution_failed' : 'native_child_preparation_failed' });
      }
      throw cause;
    }).finally(() => {
      this.pending.delete(done);
      continuation?.close();
      this.input.bus.ctrl.signal.removeEventListener('abort', abort);
      signal?.removeEventListener('abort', cancelChild); prompts?.close();
      bus.subscribers.delete(collect); clearReplayBuffer(bus);
    });
    this.pending.set(done, bus); void done.catch(() => undefined); return done;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.jobs.close();
    this.shared.mailbox.close(this.input.config.context.agentRunId);
    this.scheduler.close();
    const pending = [...this.pending];
    for (const [, bus] of pending) bus.ctrl.abort(new Error('Native parent scope closed'));
    const results = await Promise.allSettled(pending.map(([done]) => done));
    await this.jobs.drain();
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  mailboxPreparation(base: ProviderContextPreparationPort): ProviderContextPreparationPort {
    return this.shared.mailbox.preparation(this.input.config.context.agentRunId, base);
  }
  restoreInbox(entries: readonly NativeTreeInboxEntry[]) { return this.shared.mailbox.restore(this.input.config.context.agentRunId, entries); }
  bindInputInterrupt(interrupt: () => Promise<boolean>) {
    this.shared.mailbox.bindInterrupt(this.input.config.context.agentRunId, interrupt);
  }
  async drainBackground(): Promise<void> { await this.jobs.drain(); }
  background(input: { invocationId: string; task: unknown; signal?: AbortSignal }, run: (signal: AbortSignal) => Promise<ToolResult>) {
    this.list({ signal: input.signal }); return this.jobs.start(input, run);
  }
  collect(options: { jobId?: string; timeoutMs: number; signal?: AbortSignal }) {
    this.list(options); return this.jobs.collect(options);
  }
  registerContinuation(agentRunId: string, run: (text: string, signal: AbortSignal, invocationId: string) => Promise<ToolResult>) {
    const parent = this.input.config.context.agentRunId;
    if (!this.shared.inventory.list(parent).some(member => member.agent_run_id === agentRunId && !member.is_self)) throw new Error('Foreign native continuation');
    this.shared.continuations.set(agentRunId, { parent, run });
  }
  async message(input: AgentTreeMessageRequest): Promise<AgentTreeMessageReceipt> {
    const all = this.list({ signal: input.signal }), caller = this.input.config.context.agentRunId;
    const target = all.find(member => member.path === input.to || member.agent_run_id === input.to);
    if (input.kind === 'followup' && target && ['completed', 'interrupted'].includes(target.status)) {
      const continuation = this.shared.continuations.get(target.agent_run_id);
      if (!continuation || continuation.parent !== caller) throw new Error('Native follow-up requires a known terminal child and its original parent');
      const result = await this.jobs.start({ invocationId: input.invocationId,
        task: { target: target.agent_run_id, message: input.message }, signal: input.signal },
      signal => continuation.run(input.message, signal, input.invocationId));
      const jobId = (result.structuredData as { jobId: string }).jobId;
      return { id: jobId, target: target.path, status: 'started', interrupted: false, jobId };
    }
    return this.shared.mailbox.post(caller, input);
  }

  emit(event: AgentTreeEvent, data: unknown): void {
    this.input.assertOwner();
    publish(this.input.bus, event, data);
  }

  list(options: { signal?: AbortSignal }) {
    this.input.assertOwner(); this.input.bus.ctrl.signal.throwIfAborted(); options.signal?.throwIfAborted();
    if (this.closing) throw new Error('Native tree inventory owner is closing');
    return this.shared.inventory.list(this.input.config.context.agentRunId);
  }

  async wait(options: { targets: string[]; timeoutMs: number; signal?: AbortSignal }) {
    this.list(options);
    const signal = AbortSignal.any([this.input.bus.ctrl.signal, options.signal].filter((s): s is AbortSignal => !!s));
    return this.shared.inventory.wait(this.input.config.context.agentRunId, { ...options,
      timeoutMs: Math.min(options.timeoutMs, Math.max(0, this.shared.budget.limits.deadlineAtUnixMs - Date.now() - 1000)), signal });
  }

  async reconcile(reference: string, options: { signal?: AbortSignal }): Promise<AgentTreeReconciliation> {
    if (this.closing) throw new Error('Native child recovery owner is closing');
    const signal = AbortSignal.any([this.input.bus.ctrl.signal, options.signal].filter((value): value is AbortSignal => !!value));
    const resolve = () => this.input.bridge.request<NativeChildCompletionAuthority>('native.authority', {
      runId: this.input.runId, agentRunId: this.input.config.context.agentRunId, operation: { kind: 'childCompletion', reference },
    }, { timeoutMs: 30_000 });
    this.input.assertOwner(); signal.throwIfAborted();
    try {
      const source = await resolve();
      return await reconcileNativeChildJournal({ source, reference, rootPath: this.input.config.sessionRoot,
        runtimePackage: this.runtimePackage, signal, assertOwner: async () => {
          this.input.assertOwner(); signal.throwIfAborted();
          if (JSON.stringify(await resolve()) !== JSON.stringify(source)) throw new Error('Native child recovery authority changed');
          this.input.assertOwner(); signal.throwIfAborted();
        } });
    } catch (cause) {
      signal.throwIfAborted(); this.input.assertOwner();
      return { outcome: 'outcome_unknown', resultRef: reference, detail: cause instanceof Error ? cause.message : 'native child recovery unavailable' };
    }
  }

  async readTranscript(reference: string, options: { maxChars?: number; signal?: AbortSignal }): Promise<string> {
    if (this.closing) throw new Error('Native child transcript reader is closing');
    const signal = AbortSignal.any([this.input.bus.ctrl.signal, options.signal].filter((value): value is AbortSignal => !!value));
    const resolve = () => this.input.bridge.request<ControlPlaneRunContext>('native.authority', {
      runId: this.input.runId, agentRunId: this.input.config.context.agentRunId, operation: { kind: 'childTranscript', reference },
    }, { timeoutMs: 30_000 });
    this.input.assertOwner(); signal.throwIfAborted();
    const context = await resolve();
    return readNativeChildTranscript({ context, rootPath: this.input.config.sessionRoot,
      runtimePackage: this.runtimePackage, ...options, signal, assertOwner: async () => {
        this.input.assertOwner(); signal.throwIfAborted();
        if (JSON.stringify(await resolve()) !== JSON.stringify(context)) throw new Error('Native child transcript authority changed during reading');
        this.input.assertOwner(); signal.throwIfAborted();
      } });
  }
}

