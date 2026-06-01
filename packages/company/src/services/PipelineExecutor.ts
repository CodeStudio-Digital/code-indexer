/**
 * PipelineExecutor — orchestrates a pipeline graph by reusing the
 * existing `SubordinateLifecycle` and `KanbanService`. Each node spawns
 * a subordinate, attaches a single-shot `MasterAttention` listener for
 * the `finished` event, then advances along the matching outgoing edge.
 *
 * V1 capabilities:
 *   - branchMode: 'linear' | 'pass-fail' | 'by-tag' | 'by-text-match'
 *   - cycles allowed when reached through a conditional edge, capped
 *     by per-node `maxAttempts` (default 3) and a global execution
 *     cap (default 50 node executions)
 *   - `pause/resume` flips the execution row; resume re-runs the
 *     `current_node_id` so the operator can intervene mid-flight
 *   - `recoverRunning()` pauses any execution whose subordinate is no
 *     longer alive after a server restart so the dashboard can prompt
 *     a manual resume
 *
 * QA verdicts:
 *   For `pass-fail` branches the executor consults `qa_test_runs` via
 *   `qa_test_runs.kanban_feature_card_id` first, so a stage that runs a
 *   QA suite reports its verdict from the actual test counts rather
 *   than parsing the agent's final message. Falls back to a regex over
 *   the output for non-QA stages that opt into `pass-fail`.
 */

import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { SubordinateLifecycle, SpawnSubordinateSpec } from '@mcp/company/services/SubordinateLifecycle.js';
import type { KanbanService } from '@mcp/company/services/KanbanService.js';
import type { MasterAttention, AttentionEvent } from '@mcp/company/services/MasterAttention.js';
import type { IMetaBusPublisher } from '@mcp/company/services/ports.js';
import type { PipelineService } from '@mcp/company/services/PipelineService.js';
import { renderNodeTask, resolveStartNode } from '@mcp/company/services/PipelineService.js';
import { readFinalAssistantText } from '@mcp/company/services/finalText.js';
import { pickNextEdge, resolveBranchVerdictPure } from '@mcp/code-agent/pipelines/core/PipelineKernel.js';
import { FanOutRunner, type FanOutBarrier } from './pipeline-fanout.js';
import type {
  Pipeline,
  PipelineExecution,
  PipelineExecutionContext,
  PipelineExecutionStatus,
  PipelineGraph,
  PipelineNode,
  PipelineNodeExecution,
} from '@mcp/company/types.js';

// Re-exported for callers that imported from this file historically
// (e.g. existing tests). Pure logic now lives in `PipelineKernel`.
export { pickNextEdge };

const DEFAULT_NODE_MAX_ATTEMPTS = 3;
// Higher than a single-spawn pipeline would need because a fan-out node
// creates one row per branch (one per project) — N projects must not trip
// the cycle guard. Per-branch `maxAttempts` still bounds retries.
const GLOBAL_NODE_EXECUTION_CAP = 200;

export interface PipelineExecutorDeps {
  ctx: SessionContext;
  pipelines: PipelineService;
  kanban: KanbanService;
  subordinates: SubordinateLifecycle;
  attention: MasterAttention;
  publisher: IMetaBusPublisher;
}

interface ActiveListener {
  executionId: number;
  agentRunId: number;
  unsubscribe: () => void;
}

export class PipelineExecutor {
  /** Per-execution listener so `abort` can detach the attention hook. */
  private readonly activeListeners = new Map<number, ActiveListener>();
  /** Per-execution fan-out barriers (shared with `FanOutRunner`). */
  private readonly fanOutBarriers = new Map<number, FanOutBarrier>();
  private readonly fanOut: FanOutRunner;

  constructor(private readonly deps: PipelineExecutorDeps) {
    this.fanOut = new FanOutRunner({
      ctx: deps.ctx,
      kanban: deps.kanban,
      subordinates: deps.subordinates,
      attention: deps.attention,
      publisher: deps.publisher,
      barriers: this.fanOutBarriers,
      pipelineNameFor: (id) => this.pipelineNameFor(id),
      onJoin: (executionId, node, aggregated, initialInput) =>
        this.joinFanOut(executionId, node, aggregated, initialInput),
      failExecution: (executionId, pipelineId, message) =>
        this.failExecution(executionId, pipelineId, message),
    });
  }

  // ─── Public API ───────────────────────────────────────────────

  async start(
    pipelineId: number,
    initialInput: string,
    startedBy = 'master',
  ): Promise<PipelineExecution> {
    const pipeline = this.deps.pipelines.get(pipelineId);
    if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found.`);

    const startNode = resolveStartNode(pipeline.graph);
    if (!startNode) throw new Error(`Pipeline ${pipelineId} has no resolvable start node.`);

    const context: PipelineExecutionContext = {
      // Frozen snapshot — protects this execution from later edits.
      snapshot: cloneGraph(pipeline.graph),
      vars: {},
    };

    const execution = this.deps.ctx.companyStore.createPipelineExecution({
      pipelineId,
      companySessionId: this.deps.ctx.effectiveSessionId,
      initialInput,
      context,
      startedBy,
      currentNodeId: startNode.id,
    });

    this.deps.publisher.publish('pipeline_started', {
      executionId: execution.id,
      pipelineId,
      pipelineName: pipeline.name,
      startNodeId: startNode.id,
      startedBy,
    });

    void this.runNode(execution.id, startNode, initialInput, '');

    return execution;
  }

  /**
   * Mark an execution `aborted` and abort any subordinate currently
   * running for it. Best-effort: if the abort signal can't reach the
   * runner (already finished, restart in flight, etc.) we still flip
   * the row so the dashboard reflects the operator intent.
   */
  abort(executionId: number, reason?: string): boolean {
    const exec = this.deps.ctx.companyStore.getPipelineExecution(executionId);
    if (!exec) return false;
    if (exec.status !== 'running' && exec.status !== 'paused') return false;

    this.detachListener(executionId, { abortAgent: true });
    this.detachFanOut(executionId, { abortAgents: true });

    this.deps.ctx.companyStore.updatePipelineExecution(executionId, {
      status: 'aborted',
      finishedAt: nowIso(),
      errorMessage: reason ?? null,
    });

    this.deps.publisher.publish('pipeline_aborted', {
      executionId,
      pipelineId: exec.pipeline_id,
      reason: reason ?? null,
    });
    return true;
  }

  /**
   * Pause a running execution. The subordinate currently working on the
   * active node is aborted (its row in `pipeline_node_executions` is
   * marked `aborted`); the execution row stays around with `status='paused'`
   * and `current_node_id` pointing at the node to retry on resume. The
   * operator can then edit the source pipeline (the snapshot is frozen
   * regardless) or hand the work off before resuming.
   */
  pause(executionId: number): boolean {
    const exec = this.deps.ctx.companyStore.getPipelineExecution(executionId);
    if (!exec) return false;
    if (exec.status !== 'running') return false;

    const listener = this.activeListeners.get(executionId);
    let pausedNodeRowId: number | null = null;
    if (listener) {
      // Find the running node row for this agent so we can mark it aborted.
      const rows = this.deps.ctx.companyStore.listPipelineNodeExecutions(executionId);
      const last = rows[rows.length - 1];
      if (last && last.status === 'running' && last.agent_run_id === listener.agentRunId) {
        pausedNodeRowId = last.id;
        this.deps.ctx.companyStore.updatePipelineNodeExecution(last.id, {
          status: 'aborted',
          finishedAt: nowIso(),
          errorMessage: 'paused by operator',
        });
      }
    }
    this.detachListener(executionId, { abortAgent: true });
    this.detachFanOut(executionId, { abortAgents: true });

    this.deps.ctx.companyStore.updatePipelineExecution(executionId, { status: 'paused' });
    this.deps.publisher.publish('pipeline_paused', {
      executionId,
      pipelineId: exec.pipeline_id,
      nodeId: exec.current_node_id,
      pausedNodeExecutionId: pausedNodeRowId,
    });
    return true;
  }

  /**
   * Resume a paused execution by re-running the node identified by
   * `current_node_id`. The retry counter advances from the previous
   * attempt count; if `current_node_id` is null the execution is
   * marked `failed` because there's nothing to do.
   */
  async resume(executionId: number): Promise<boolean> {
    const exec = this.deps.ctx.companyStore.getPipelineExecution(executionId);
    if (!exec) return false;
    if (exec.status !== 'paused') return false;

    const node = exec.current_node_id
      ? exec.context.snapshot.nodes.find((n) => n.id === exec.current_node_id)
      : null;
    if (!node) {
      this.failExecution(executionId, exec.pipeline_id, 'Resume failed: current_node_id is missing or unknown.');
      return false;
    }

    this.deps.ctx.companyStore.updatePipelineExecution(executionId, { status: 'running' });
    this.deps.publisher.publish('pipeline_resumed', {
      executionId,
      pipelineId: exec.pipeline_id,
      nodeId: node.id,
    });

    const previousOutput = lastOutputForResume(exec.context, node.id);
    void this.runNode(executionId, node, exec.initial_input, previousOutput);
    return true;
  }

  /**
   * Approve a pause caused by `requires_confirmation`. Runtime semantics
   * mirror `resume()` (re-run `current_node_id`, which points at the
   * not-yet-run next node); the distinct verb keeps the audit log clear.
   */
  async confirm(executionId: number): Promise<boolean> {
    return this.resume(executionId);
  }

  status(executionId: number): {
    execution: PipelineExecution;
    nodes: PipelineNodeExecution[];
  } | null {
    const execution = this.deps.ctx.companyStore.getPipelineExecution(executionId);
    if (!execution) return null;
    const nodes = this.deps.ctx.companyStore.listPipelineNodeExecutions(executionId);
    return { execution, nodes };
  }

  listExecutions(opts?: {
    pipelineId?: number;
    status?: PipelineExecutionStatus;
    limit?: number;
  }): PipelineExecution[] {
    return this.deps.ctx.companyStore.listPipelineExecutions({
      companySessionId: this.deps.ctx.effectiveSessionId,
      pipelineId: opts?.pipelineId,
      status: opts?.status,
      limit: opts?.limit,
    });
  }

  /**
   * Reconcile any `running` execution against the current set of live
   * subordinates. After a server restart no in-memory listener exists,
   * so the right thing is to flip the row to `paused` and let the
   * operator decide whether to resume. We never silently re-run.
   */
  async recoverRunning(): Promise<{ paused: number }> {
    const running = this.deps.ctx.companyStore.listPipelineExecutions({
      companySessionId: this.deps.ctx.effectiveSessionId,
      status: 'running',
    });
    let paused = 0;
    for (const exec of running) {
      // Mark the last running node aborted (if any) so the timeline reflects reality.
      const rows = this.deps.ctx.companyStore.listPipelineNodeExecutions(exec.id);
      const last = rows[rows.length - 1];
      if (last && last.status === 'running') {
        this.deps.ctx.companyStore.updatePipelineNodeExecution(last.id, {
          status: 'aborted',
          finishedAt: nowIso(),
          errorMessage: 'server restart — agent no longer alive',
        });
      }
      this.deps.ctx.companyStore.updatePipelineExecution(exec.id, { status: 'paused' });
      this.deps.publisher.publish('pipeline_paused', {
        executionId: exec.id,
        pipelineId: exec.pipeline_id,
        nodeId: exec.current_node_id,
        reason: 'recovered',
      });
      paused++;
    }
    return { paused };
  }

  // ─── Internal: node loop ─────────────────────────────────────

  private async runNode(
    executionId: number,
    node: PipelineNode,
    initialInput: string,
    previousOutput: string,
  ): Promise<void> {
    const exec = this.deps.ctx.companyStore.getPipelineExecution(executionId);
    if (!exec || exec.status !== 'running') return;

    // Global cap: protects against pathological cycles that slip past
    // the per-node maxAttempts guard.
    const allRows = this.deps.ctx.companyStore.listPipelineNodeExecutions(executionId);
    if (allRows.length >= GLOBAL_NODE_EXECUTION_CAP) {
      this.failExecution(
        executionId,
        exec.pipeline_id,
        `Aborted after ${GLOBAL_NODE_EXECUTION_CAP} node executions (global cycle cap).`,
      );
      return;
    }

    // Fan-out node: spawn N branches and barrier-join via FanOutRunner,
    // which calls back into `joinFanOut` to advance. Bypasses the single-
    // spawn path below (and its per-node attempt guard — branches manage
    // their own retries).
    if (node.kind === 'fan-out') {
      void this.fanOut.run(executionId, node, initialInput, previousOutput);
      return;
    }

    // Per-node attempt count — counts every previous run of this node
    // in the current execution, regardless of outcome.
    const previousAttemptsForNode = allRows.filter((r) => r.node_id === node.id).length;
    const maxAttempts = Math.max(1, node.maxAttempts ?? DEFAULT_NODE_MAX_ATTEMPTS);
    if (previousAttemptsForNode >= maxAttempts) {
      this.failExecution(
        executionId,
        exec.pipeline_id,
        `Node "${node.id}" exceeded maxAttempts (${maxAttempts}).`,
      );
      return;
    }

    const renderedTask = renderNodeTask({
      template: node.taskTemplate,
      initialInput,
      previousOutput,
      vars: exec.context.vars,
    });

    const pipelineName = await this.pipelineNameFor(exec.pipeline_id);
    const card = this.deps.kanban.createCard({
      title: `[Pipeline:${pipelineName}] ${node.label}`,
      description: renderedTask,
      column: 'todo',
      tag: node.kanbanTag ?? null,
      created_by: 'pipeline',
    });

    let nodeExec: PipelineNodeExecution;
    try {
      nodeExec = this.deps.ctx.companyStore.createPipelineNodeExecution({
        executionId,
        nodeId: node.id,
        nodeLabel: node.label,
        role: node.role,
        inputText: renderedTask,
        attempt: previousAttemptsForNode + 1,
        kanbanCardId: card.id,
      });
    } catch (e) {
      this.failExecution(executionId, exec.pipeline_id, `Failed to record node execution: ${(e as Error).message}`);
      return;
    }

    this.deps.publisher.publish('pipeline_node_started', {
      executionId,
      pipelineId: exec.pipeline_id,
      nodeId: node.id,
      nodeLabel: node.label,
      role: node.role,
      cardId: card.id,
      nodeExecutionId: nodeExec.id,
      attempt: previousAttemptsForNode + 1,
    });

    let spawnResult: { agentRunId: number; coderSessionId: number; status: string };
    try {
      const spec: SpawnSubordinateSpec = {
        role: node.role,
        task: renderedTask,
        projectId: node.projectId,
        skills: node.extraSkills,
        // SDD pipeline: spec-writer nodes run their subordinate under
        // built-in `spec` agent — loads spec.txt prompt, blocks mutating
        // tools until `submit_specification_to_master` is approved.
        agent: node.kind === 'spec' ? 'spec' : undefined,
      };
      spawnResult = await this.deps.subordinates.spawn(spec);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.deps.ctx.companyStore.updatePipelineNodeExecution(nodeExec.id, {
        status: 'failed',
        finishedAt: nowIso(),
        errorMessage: msg,
      });
      this.deps.publisher.publish('pipeline_node_failed', {
        executionId,
        pipelineId: exec.pipeline_id,
        nodeId: node.id,
        error: msg,
      });
      this.failExecution(executionId, exec.pipeline_id, `Node "${node.id}" failed to spawn: ${msg}`);
      return;
    }

    try {
      this.deps.kanban.assignAgent(card.id, spawnResult.agentRunId, node.role);
      this.deps.kanban.moveCard(card.id, 'in_progress');
    } catch { /* best-effort */ }

    this.deps.ctx.companyStore.updatePipelineNodeExecution(nodeExec.id, {
      agentRunId: spawnResult.agentRunId,
    });

    const unsubscribe = this.deps.attention.on((ev: AttentionEvent) => {
      if (ev.kind !== 'finished') return;
      if (ev.agentRunId !== spawnResult.agentRunId) return;
      const listener = this.activeListeners.get(executionId);
      if (listener) listener.unsubscribe();
      this.activeListeners.delete(executionId);
      void this.onNodeFinished(executionId, node, nodeExec.id, spawnResult.coderSessionId, card.id, initialInput);
    });
    this.activeListeners.set(executionId, {
      executionId,
      agentRunId: spawnResult.agentRunId,
      unsubscribe,
    });
  }

  private async onNodeFinished(
    executionId: number,
    node: PipelineNode,
    nodeExecutionId: number,
    coderSessionId: number,
    cardId: number,
    initialInput: string,
  ): Promise<void> {
    const exec = this.deps.ctx.companyStore.getPipelineExecution(executionId);
    if (!exec) return;
    // pause/abort happened mid-flight: don't advance.
    if (exec.status !== 'running') return;

    const finalText = readFinalAssistantText(coderSessionId) ?? '';
    const output = finalText;

    // Resolve the outgoing edge based on this node's branch mode. The
    // outcome string is recorded on the node row so the dashboard can
    // show *why* the executor went the way it did.
    const outgoing = exec.context.snapshot.edges.filter((e) => e.from === node.id);
    const branchMode = node.branchMode ?? 'linear';
    const verdict = this.resolveBranchVerdict(branchMode, output, cardId);
    const next = pickNextEdge(outgoing, branchMode, verdict);

    const updatedContext: PipelineExecutionContext = {
      snapshot: exec.context.snapshot,
      vars: {
        ...exec.context.vars,
        [node.id]: { output, outcome: next?.outcome ?? branchMode },
      },
    };
    this.deps.ctx.companyStore.updatePipelineNodeExecution(nodeExecutionId, {
      status: 'completed',
      outputText: output,
      outcomeBranch: next?.outcome ?? null,
      finishedAt: nowIso(),
    });
    this.deps.ctx.companyStore.updatePipelineExecution(executionId, {
      context: updatedContext,
    });

    if (node.kanbanColumnTarget) {
      try { this.deps.kanban.moveCard(cardId, node.kanbanColumnTarget); }
      catch { /* best-effort */ }
    }

    this.deps.publisher.publish('pipeline_node_completed', {
      executionId,
      pipelineId: exec.pipeline_id,
      nodeId: node.id,
      cardId,
      outcome: next?.outcome ?? null,
      outputPreview: output.slice(0, 240),
    });

    this.advanceToNext(executionId, exec.pipeline_id, node, next, outgoing.length, exec.context.snapshot, initialInput, output, branchMode, verdict);
  }

  /**
   * Shared "advance the execution" tail used by both the single-spawn path
   * and the fan-out join: route to the next node, hit a terminal, or pause
   * for a `requires_confirmation` gate.
   */
  private advanceToNext(
    executionId: number,
    pipelineId: number,
    node: PipelineNode,
    next: { targetId: string; outcome: string | null } | null,
    outgoingCount: number,
    snapshot: PipelineGraph,
    initialInput: string,
    output: string,
    branchMode: NonNullable<PipelineNode['branchMode']>,
    verdict: string | null,
  ): void {
    if (!next) {
      // No matching outgoing edge — terminal node reached, OR a condition
      // with no fallback. Treat zero-outgoing as 'completed'; a dead-end
      // condition surfaces as 'failed'.
      if (outgoingCount === 0) {
        this.completeExecution(executionId, pipelineId);
      } else {
        this.failExecution(
          executionId,
          pipelineId,
          `Node "${node.id}" produced no matching branch (mode=${branchMode}, verdict=${verdict ?? 'none'}).`,
        );
      }
      return;
    }

    const nextNode = snapshot.nodes.find((n) => n.id === next.targetId);
    if (!nextNode) {
      this.failExecution(executionId, pipelineId, `Edge from "${node.id}" points at missing node "${next.targetId}".`);
      return;
    }

    this.deps.ctx.companyStore.updatePipelineExecution(executionId, { currentNodeId: nextNode.id });

    // Human-in-the-loop gate: when the node that just finished asked for
    // confirmation, pause BEFORE running the next node. `current_node_id`
    // already points at `nextNode`, so `confirm()` (→ resume) runs it.
    if (node.requires_confirmation) {
      this.deps.ctx.companyStore.updatePipelineExecution(executionId, { status: 'paused' });
      this.deps.publisher.publish('pipeline_paused', {
        executionId,
        pipelineId,
        nodeId: nextNode.id,
        reason: 'awaiting_confirmation',
      });
      return;
    }

    void this.runNode(executionId, nextNode, initialInput, output);
  }

  /**
   * Join callback for `FanOutRunner`: the aggregated output of all branches
   * becomes this node's output. Fan-out nodes are linear, so route the
   * single outgoing edge and advance (same terminal/confirmation rules).
   */
  private joinFanOut(executionId: number, node: PipelineNode, aggregated: string, initialInput: string): void {
    const exec = this.deps.ctx.companyStore.getPipelineExecution(executionId);
    if (!exec || exec.status !== 'running') return;

    const outgoing = exec.context.snapshot.edges.filter((e) => e.from === node.id);
    const next = pickNextEdge(outgoing, 'linear', null);

    const updatedContext: PipelineExecutionContext = {
      snapshot: exec.context.snapshot,
      vars: { ...exec.context.vars, [node.id]: { output: aggregated, outcome: next?.outcome ?? 'linear' } },
    };
    this.deps.ctx.companyStore.updatePipelineExecution(executionId, { context: updatedContext });

    this.deps.publisher.publish('pipeline_node_completed', {
      executionId,
      pipelineId: exec.pipeline_id,
      nodeId: node.id,
      outcome: next?.outcome ?? null,
      outputPreview: aggregated.slice(0, 240),
    });

    this.advanceToNext(executionId, exec.pipeline_id, node, next, outgoing.length, exec.context.snapshot, initialInput, aggregated, 'linear', null);
  }

  /**
   * Compute the verdict string used to pick the next branch. Thin wrapper
   * around the pure kernel function — closes over the company-specific
   * resolvers (QA verdict from `qa_test_runs`, kanban tag for the card).
   */
  private resolveBranchVerdict(
    mode: NonNullable<PipelineNode['branchMode']>,
    output: string,
    cardId: number,
  ): string | null {
    return resolveBranchVerdictPure({
      mode,
      output,
      // Prefer the QA verdict computed from real test counts; this
      // sidesteps the agent's prose entirely. The session's own QA
      // bridge keeps the linkage fresh whenever the agent fires
      // a Playwright run scoped to the feature card.
      qaResolver: () => readQaVerdictForCard(this.deps.ctx, cardId),
      tagResolver: () => this.deps.kanban.getCard(cardId)?.tag ?? null,
    });
  }

  // ─── Internal: terminal transitions ───────────────────────────

  private completeExecution(executionId: number, pipelineId: number): void {
    this.deps.ctx.companyStore.updatePipelineExecution(executionId, {
      status: 'completed',
      finishedAt: nowIso(),
    });
    this.deps.publisher.publish('pipeline_completed', { executionId, pipelineId });
  }

  private failExecution(executionId: number, pipelineId: number, message: string): void {
    this.deps.ctx.companyStore.updatePipelineExecution(executionId, {
      status: 'failed',
      finishedAt: nowIso(),
      errorMessage: message,
    });
    this.deps.publisher.publish('pipeline_failed', { executionId, pipelineId, error: message });
  }

  private detachListener(executionId: number, opts: { abortAgent: boolean }): void {
    const listener = this.activeListeners.get(executionId);
    if (!listener) return;
    listener.unsubscribe();
    this.activeListeners.delete(executionId);
    if (opts.abortAgent) {
      try { this.deps.subordinates.abort(listener.agentRunId); } catch { /* best-effort */ }
    }
  }

  /** Tear down a fan-out barrier: unsubscribe + abort every in-flight branch. */
  private detachFanOut(executionId: number, opts: { abortAgents: boolean }): void {
    const barrier = this.fanOutBarriers.get(executionId);
    if (!barrier) return;
    barrier.unsubscribe();
    this.fanOutBarriers.delete(executionId);
    if (opts.abortAgents) {
      for (const agentRunId of barrier.pending) {
        try { this.deps.subordinates.abort(agentRunId); } catch { /* best-effort */ }
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private async pipelineNameFor(pipelineId: number): Promise<string> {
    const p = this.deps.pipelines.get(pipelineId);
    return p?.name ?? `pipeline-${pipelineId}`;
  }
}

/**
 * Read the most recent completed QA run scoped to this card and
 * derive a pass/fail verdict from its counters. Returns `null` when
 * there's no run linked to the card or the latest run is still
 * 'running'/'aborted'/'error'.
 */
function readQaVerdictForCard(ctx: SessionContext, cardId: number): 'pass' | 'fail' | null {
  try {
    return ctx.companyStore.getLatestQaVerdictForCard(ctx.effectiveSessionId, cardId);
  } catch {
    return null;
  }
}

/**
 * On resume, prefer the most recent completed run of this node within
 * the execution as the `previous_output` placeholder source. Fallback
 * to the upstream node's accumulated output when the node has no
 * completed runs yet (resume after the very first attempt was paused).
 */
function lastOutputForResume(context: PipelineExecutionContext, nodeId: string): string {
  const v = context.vars[nodeId];
  if (v?.output) return v.output;
  // Try walking the snapshot for an in-edge and reading that node's output.
  const inEdge = context.snapshot.edges.find((e) => e.to === nodeId);
  if (inEdge) {
    return context.vars[inEdge.from]?.output ?? '';
  }
  return '';
}

function cloneGraph(g: PipelineGraph): PipelineGraph {
  return JSON.parse(JSON.stringify(g)) as PipelineGraph;
}

function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}
