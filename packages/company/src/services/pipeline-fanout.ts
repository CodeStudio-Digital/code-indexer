/**
 * FanOutRunner — executes a `kind: 'fan-out'` pipeline node by spawning
 * several subordinates in one step (one per explicit branch, or one per
 * project in the session), waiting for ALL to finish (barrier), then
 * aggregating their outputs and handing back to the executor to advance.
 *
 * Best-effort: a failed branch retries up to the node's `maxAttempts`;
 * remaining failures are recorded in the aggregated output rather than
 * failing the whole pipeline. The barrier registry is shared with
 * `PipelineExecutor` so pause/abort can reach every in-flight branch.
 */
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { KanbanService } from '@mcp/company/services/KanbanService.js';
import type { SubordinateLifecycle } from '@mcp/company/services/SubordinateLifecycle.js';
import type { MasterAttention, AttentionEvent } from '@mcp/company/services/MasterAttention.js';
import type { IMetaBusPublisher } from '@mcp/company/services/ports.js';
import { renderNodeTask } from '@mcp/company/services/PipelineService.js';
import { readFinalAssistantText } from '@mcp/company/services/finalText.js';
import type { PipelineNode } from '@mcp/company/types.js';

const DEFAULT_BRANCH_MAX_ATTEMPTS = 3;

interface ResolvedBranch { role: string; projectId?: number; taskTemplate: string; label: string }
interface BranchState {
  branch: ResolvedBranch;
  cardId: number;
  rowId: number;
  attempt: number;
  coderSessionId: number;
  output: string;
  ok: boolean;
}

export interface FanOutBarrier {
  executionId: number;
  node: PipelineNode;
  initialInput: string;
  previousOutput: string;
  spawning: boolean;
  pending: Set<number>;
  byAgent: Map<number, BranchState>;
  results: BranchState[];
  unsubscribe: () => void;
}

export interface FanOutRunnerDeps {
  ctx: SessionContext;
  kanban: KanbanService;
  subordinates: SubordinateLifecycle;
  attention: MasterAttention;
  publisher: IMetaBusPublisher;
  /** Shared with the executor so pause/abort can iterate in-flight branches. */
  barriers: Map<number, FanOutBarrier>;
  pipelineNameFor: (pipelineId: number) => Promise<string>;
  onJoin: (executionId: number, node: PipelineNode, aggregated: string, initialInput: string) => void;
  failExecution: (executionId: number, pipelineId: number, message: string) => void;
}

export class FanOutRunner {
  constructor(private readonly d: FanOutRunnerDeps) {}

  async run(executionId: number, node: PipelineNode, initialInput: string, previousOutput: string): Promise<void> {
    const exec = this.d.ctx.companyStore.getPipelineExecution(executionId);
    if (!exec || exec.status !== 'running') return;
    const branches = this.resolveBranches(node);
    if (branches.length === 0) {
      this.d.failExecution(executionId, exec.pipeline_id, `Fan-out node "${node.id}" resolved zero branches.`);
      return;
    }
    const pipelineName = await this.d.pipelineNameFor(exec.pipeline_id);
    const barrier: FanOutBarrier = {
      executionId, node, initialInput, previousOutput,
      spawning: true, pending: new Set(), byAgent: new Map(), results: [], unsubscribe: () => {},
    };
    this.d.barriers.set(executionId, barrier);
    barrier.unsubscribe = this.d.attention.on((ev: AttentionEvent) => {
      if (ev.kind !== 'finished' || !barrier.pending.has(ev.agentRunId)) return;
      void this.onBranchFinished(executionId, ev.agentRunId);
    });

    this.d.publisher.publish('pipeline_node_started', {
      executionId, pipelineId: exec.pipeline_id, nodeId: node.id, nodeLabel: node.label,
      role: node.role, fanOutBranches: branches.length,
    });

    // Spawn branches concurrently — the synchronous reservation in
    // `subordinates.spawn` keeps the concurrency cap honest under the race, so
    // we no longer pay N× serial boot latency to fan a node out. A branch whose
    // own spawn rejects is recorded as a failed branch inside spawnBranch
    // (same as the serial path), so Promise.all never rejects here.
    await Promise.all(
      branches.map((branch) => this.spawnBranch(executionId, pipelineName, node, branch, 1, barrier)),
    );
    barrier.spawning = false;
    this.maybeJoin(executionId);
  }

  private resolveBranches(node: PipelineNode): ResolvedBranch[] {
    const fo = node.fanOut;
    if (!fo) return [];
    if (fo.mode === 'each-project') {
      const role = fo.role ?? node.role;
      return this.d.ctx.projects.map((p) => ({
        role,
        projectId: p.project_id,
        taskTemplate: node.taskTemplate,
        label: p.label ?? `project ${p.project_id}`,
      }));
    }
    return (fo.branches ?? []).map((b, i) => ({
      role: b.role,
      projectId: b.projectId,
      taskTemplate: b.taskTemplate ?? node.taskTemplate,
      label: b.label ?? `${b.role}#${i + 1}`,
    }));
  }

  private async spawnBranch(
    executionId: number, pipelineName: string, node: PipelineNode,
    branch: ResolvedBranch, attempt: number, barrier: FanOutBarrier,
  ): Promise<void> {
    const exec = this.d.ctx.companyStore.getPipelineExecution(executionId);
    const renderedTask = renderNodeTask({
      template: branch.taskTemplate,
      initialInput: barrier.initialInput,
      previousOutput: barrier.previousOutput,
      vars: exec?.context.vars ?? {},
    });
    const card = this.d.kanban.createCard({
      title: `[Pipeline:${pipelineName}] ${node.label} · ${branch.label}`,
      description: renderedTask, column: 'todo', tag: node.kanbanTag ?? null, created_by: 'pipeline',
    });
    const row = this.d.ctx.companyStore.createPipelineNodeExecution({
      executionId, nodeId: node.id, nodeLabel: `${node.label} · ${branch.label}`,
      role: branch.role, inputText: renderedTask, attempt, kanbanCardId: card.id,
    });
    let spawn: { agentRunId: number; coderSessionId: number };
    try {
      spawn = await this.d.subordinates.spawn({ role: branch.role, task: renderedTask, projectId: branch.projectId, skills: node.extraSkills });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.d.ctx.companyStore.updatePipelineNodeExecution(row.id, { status: 'failed', finishedAt: nowIso(), errorMessage: msg });
      barrier.results.push({ branch, cardId: card.id, rowId: row.id, attempt, coderSessionId: 0, output: `(spawn failed: ${msg})`, ok: false });
      return;
    }
    try { this.d.kanban.assignAgent(card.id, spawn.agentRunId, branch.role); this.d.kanban.moveCard(card.id, 'in_progress'); } catch { /* best-effort */ }
    this.d.ctx.companyStore.updatePipelineNodeExecution(row.id, { agentRunId: spawn.agentRunId });
    barrier.pending.add(spawn.agentRunId);
    barrier.byAgent.set(spawn.agentRunId, { branch, cardId: card.id, rowId: row.id, attempt, coderSessionId: spawn.coderSessionId, output: '', ok: false });
  }

  private async onBranchFinished(executionId: number, agentRunId: number): Promise<void> {
    const barrier = this.d.barriers.get(executionId);
    if (!barrier) return;
    const state = barrier.byAgent.get(agentRunId);
    if (!state) return;
    barrier.byAgent.delete(agentRunId);
    barrier.pending.delete(agentRunId);

    const status = this.d.subordinates.statusOf(agentRunId);
    const ok = status === 'completed';
    const output = readFinalAssistantText(state.coderSessionId) ?? '';
    const maxAttempts = Math.max(1, barrier.node.maxAttempts ?? DEFAULT_BRANCH_MAX_ATTEMPTS);

    if (!ok && state.attempt < maxAttempts) {
      this.d.ctx.companyStore.updatePipelineNodeExecution(state.rowId, {
        status: 'aborted', finishedAt: nowIso(), errorMessage: `attempt ${state.attempt} failed (${status ?? 'unknown'}); retrying`,
      });
      const pipelineName = await this.d.pipelineNameFor(this.pipelineIdFor(executionId));
      await this.spawnBranch(executionId, pipelineName, barrier.node, state.branch, state.attempt + 1, barrier);
      this.maybeJoin(executionId);
      return;
    }

    this.d.ctx.companyStore.updatePipelineNodeExecution(state.rowId, {
      status: ok ? 'completed' : 'failed', outputText: output, finishedAt: nowIso(),
      errorMessage: ok ? null : `branch failed (${status ?? 'unknown'})`,
    });
    barrier.results.push({ ...state, output, ok });
    this.maybeJoin(executionId);
  }

  private maybeJoin(executionId: number): void {
    const barrier = this.d.barriers.get(executionId);
    if (!barrier || barrier.spawning || barrier.pending.size > 0) return;
    barrier.unsubscribe();
    this.d.barriers.delete(executionId);
    const aggregated = barrier.results
      .map((r) => `### ${r.branch.label} [${r.ok ? 'ok' : 'FALHOU'}]\n${r.output || '(sem saída)'}`)
      .join('\n\n');
    this.d.onJoin(executionId, barrier.node, aggregated, barrier.initialInput);
  }

  private pipelineIdFor(executionId: number): number {
    return this.d.ctx.companyStore.getPipelineExecution(executionId)?.pipeline_id ?? 0;
  }
}

function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}
