/**
 * ChatPipelineExecutor — orchestrates a pipeline graph owned by a
 * `coder_sessions` row (the chat pipeline mode).
 *
 * Mirrors the public API of the company `PipelineExecutor` so the HTTP
 * route layer (PR-3) can swap which executor handles a request without
 * the caller knowing. Internally it differs in three ways:
 *
 *   1. Each stage runs as an in-memory `runSubagent` — no
 *      `SubordinateLifecycle`, no `KanbanService`, no `MasterAttention`.
 *   2. Per-stage model selection: `node.model_override` is honored via
 *      `resolveStageProvider` (cached per execution).
 *   3. Validator-kind nodes get a single tool — `submit_verdict` — and
 *      the executor reads the verdict from a closure-captured ref. The
 *      `verdictTokenResolver` plugged into `resolveBranchVerdictPure`
 *      lets the kernel route along `pass | fail | review` edges.
 *
 * Persistence still lands in the tables created by migration 058 (and
 * extended by migration 077 for `coder_session_id` + `usage_json`), so
 * the dashboard's pipeline read paths continue to work.
 */

import { runSubagent } from '@mcp/code-agent/tools/implement-subagent.js';
import {
  pickNextEdge,
  resolveBranchVerdictPure,
  type BranchMode,
} from '@mcp/code-agent/pipelines/core/PipelineKernel.js';
import {
  buildSubmitVerdictTool,
  type VerdictPayload,
  type VerdictRef,
} from '@mcp/code-agent/pipelines/tools/submit-verdict.js';
import {
  makeProviderCache,
  resolveStageProvider,
  type ProviderCache,
} from '@mcp/code-agent/pipelines/lib/resolveStageProvider.js';
import {
  buildValidatorSystemPrompt,
  buildValidatorUserMessage,
} from '@mcp/code-agent/pipelines/lib/validatorPrompt.js';
import { renderNodeTask, resolveStartNode } from '@mcp/company/services/PipelineService.js';
import {
  EXPLORE_ALLOWLIST,
  IMPLEMENT_ALLOWLIST,
} from '@mcp/code-agent/tools/implement-subagent.js';
import type { ChatPipelineBus } from '@mcp/code-agent/pipelines/lib/eventBus.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { SessionStore } from '@mcp/code-agent/sessions/store.js';
import type { CompanyStore } from '@mcp/store/company-store.js';
import type {
  PipelineEdge,
  PipelineExecution,
  PipelineExecutionContext,
  PipelineExecutionStatus,
  PipelineGraph,
  PipelineNode,
  PipelineNodeExecution,
} from '@mcp/company/types.js';

const DEFAULT_NODE_MAX_ATTEMPTS = 3;
const GLOBAL_NODE_EXECUTION_CAP = 50;
const DEFAULT_AGENT_MAX_TURNS = 60;
const DEFAULT_VALIDATOR_MAX_TURNS = 6;

export interface ChatPipelineExecutorDeps {
  /** Owner chat session — published on every event and stored on every row. */
  coderSessionId: number;
  /** Default provider for stages without `model_override`. */
  defaultProvider: ChatProvider;
  /** Tools the parent chat session has registered. Filtered per-stage. */
  parentTools: CoderTool[];
  /** Tool context inherited by each stage subagent (cwd, overlay, etc.). */
  baseContext: Pick<ToolContext, 'cwd' | 'projectName' | 'overlay'>;
  sessionStore: SessionStore;
  companyStore: CompanyStore;
  bus: ChatPipelineBus;
  /** Optional V2 framing flag, propagated to each stage's runSubagent. */
  agentLoopV2?: boolean;
}

interface ActiveStage {
  executionId: number;
  controller: AbortController;
  nodeExecutionId: number;
}

export class ChatPipelineExecutor {
  /** Per-execution AbortController so pause/abort can interrupt the running stage. */
  private readonly activeStages = new Map<number, ActiveStage>();
  /** Provider cache lives per-executor; identical (provider, model) pairs reuse instances. */
  private readonly providerCache: ProviderCache = makeProviderCache();

  constructor(private readonly deps: ChatPipelineExecutorDeps) {}

  // ─── Public API (mirrors company executor) ──────────────────────

  async start(
    pipelineId: number,
    initialInput: string,
    startedBy = 'user',
  ): Promise<PipelineExecution> {
    const pipeline = this.deps.companyStore.getPipeline(pipelineId);
    if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found.`);

    const startNode = resolveStartNode(pipeline.graph);
    if (!startNode) throw new Error(`Pipeline ${pipelineId} has no resolvable start node.`);

    const context: PipelineExecutionContext = {
      snapshot: cloneGraph(pipeline.graph),
      vars: {},
    };

    const execution = this.deps.companyStore.createPipelineExecution({
      pipelineId,
      coderSessionId: this.deps.coderSessionId,
      initialInput,
      context,
      startedBy,
      currentNodeId: startNode.id,
    });

    this.deps.bus.publish({
      name: 'pipeline_started',
      coderSessionId: this.deps.coderSessionId,
      executionId: execution.id,
      pipelineId,
      payload: { pipelineName: pipeline.name, startNodeId: startNode.id, startedBy },
    });

    void this.runNode(execution.id, startNode, initialInput, '');
    return execution;
  }

  abort(executionId: number, reason?: string): boolean {
    const exec = this.deps.companyStore.getPipelineExecution(executionId);
    if (!exec) return false;
    if (exec.status !== 'running' && exec.status !== 'paused') return false;

    this.detachStage(executionId, { abort: true });

    this.deps.companyStore.updatePipelineExecution(executionId, {
      status: 'aborted',
      finishedAt: nowIso(),
      errorMessage: reason ?? null,
    });

    this.deps.bus.publish({
      name: 'pipeline_aborted',
      coderSessionId: this.deps.coderSessionId,
      executionId,
      pipelineId: exec.pipeline_id,
      payload: { reason: reason ?? null },
    });
    return true;
  }

  pause(executionId: number): boolean {
    const exec = this.deps.companyStore.getPipelineExecution(executionId);
    if (!exec) return false;
    if (exec.status !== 'running') return false;

    const stage = this.activeStages.get(executionId);
    let pausedNodeRowId: number | null = null;
    if (stage) {
      pausedNodeRowId = stage.nodeExecutionId;
      this.deps.companyStore.updatePipelineNodeExecution(stage.nodeExecutionId, {
        status: 'aborted',
        finishedAt: nowIso(),
        errorMessage: 'paused by operator',
      });
    }
    this.detachStage(executionId, { abort: true });

    this.deps.companyStore.updatePipelineExecution(executionId, { status: 'paused' });
    this.deps.bus.publish({
      name: 'pipeline_paused',
      coderSessionId: this.deps.coderSessionId,
      executionId,
      pipelineId: exec.pipeline_id,
      payload: { nodeId: exec.current_node_id, pausedNodeExecutionId: pausedNodeRowId },
    });
    return true;
  }

  async resume(executionId: number): Promise<boolean> {
    const exec = this.deps.companyStore.getPipelineExecution(executionId);
    if (!exec) return false;
    if (exec.status !== 'paused') return false;

    const node = exec.current_node_id
      ? exec.context.snapshot.nodes.find((n) => n.id === exec.current_node_id)
      : null;
    if (!node) {
      this.failExecution(executionId, exec.pipeline_id, 'Resume failed: current_node_id is missing or unknown.');
      return false;
    }

    this.deps.companyStore.updatePipelineExecution(executionId, { status: 'running' });
    this.deps.bus.publish({
      name: 'pipeline_resumed',
      coderSessionId: this.deps.coderSessionId,
      executionId,
      pipelineId: exec.pipeline_id,
      payload: { nodeId: node.id },
    });

    const previousOutput = lastOutputForResume(exec.context, node.id);
    void this.runNode(executionId, node, exec.initial_input, previousOutput);
    return true;
  }

  status(executionId: number): {
    execution: PipelineExecution;
    nodes: PipelineNodeExecution[];
  } | null {
    const execution = this.deps.companyStore.getPipelineExecution(executionId);
    if (!execution) return null;
    const nodes = this.deps.companyStore.listPipelineNodeExecutions(executionId);
    return { execution, nodes };
  }

  listExecutions(opts?: {
    pipelineId?: number;
    status?: PipelineExecutionStatus;
    limit?: number;
  }): PipelineExecution[] {
    return this.deps.companyStore.listPipelineExecutions({
      coderSessionId: this.deps.coderSessionId,
      pipelineId: opts?.pipelineId,
      status: opts?.status,
      limit: opts?.limit,
    });
  }

  /**
   * After a process restart, in-memory subagents are gone. Flip any
   * still-`running` chat-pipeline execution to `paused` so the user can
   * decide whether to resume — same semantics as the company executor.
   */
  async recoverRunning(): Promise<{ paused: number }> {
    const running = this.deps.companyStore.listPipelineExecutions({
      coderSessionId: this.deps.coderSessionId,
      status: 'running',
    });
    let paused = 0;
    for (const exec of running) {
      const rows = this.deps.companyStore.listPipelineNodeExecutions(exec.id);
      const last = rows[rows.length - 1];
      if (last && last.status === 'running') {
        this.deps.companyStore.updatePipelineNodeExecution(last.id, {
          status: 'aborted',
          finishedAt: nowIso(),
          errorMessage: 'server restart — subagent no longer alive',
        });
      }
      this.deps.companyStore.updatePipelineExecution(exec.id, { status: 'paused' });
      this.deps.bus.publish({
        name: 'pipeline_paused',
        coderSessionId: this.deps.coderSessionId,
        executionId: exec.id,
        pipelineId: exec.pipeline_id,
        payload: { nodeId: exec.current_node_id, reason: 'recovered' },
      });
      paused++;
    }
    return { paused };
  }

  // ─── Internal: node loop ────────────────────────────────────────

  private async runNode(
    executionId: number,
    node: PipelineNode,
    initialInput: string,
    previousOutput: string,
  ): Promise<void> {
    const exec = this.deps.companyStore.getPipelineExecution(executionId);
    if (!exec || exec.status !== 'running') return;

    // Global cap defends against pathological cycles that escape the
    // per-node `maxAttempts` guard (e.g. wide fan-out with rotating
    // verdicts).
    const allRows = this.deps.companyStore.listPipelineNodeExecutions(executionId);
    if (allRows.length >= GLOBAL_NODE_EXECUTION_CAP) {
      this.failExecution(
        executionId,
        exec.pipeline_id,
        `Aborted after ${GLOBAL_NODE_EXECUTION_CAP} node executions (global cycle cap).`,
      );
      return;
    }

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

    const nodeExec = this.deps.companyStore.createPipelineNodeExecution({
      executionId,
      nodeId: node.id,
      nodeLabel: node.label,
      role: node.role,
      inputText: renderedTask,
      attempt: previousAttemptsForNode + 1,
    });

    this.deps.bus.publish({
      name: 'pipeline_node_started',
      coderSessionId: this.deps.coderSessionId,
      executionId,
      pipelineId: exec.pipeline_id,
      payload: {
        nodeId: node.id,
        nodeLabel: node.label,
        kind: node.kind ?? 'agent',
        nodeExecutionId: nodeExec.id,
        attempt: previousAttemptsForNode + 1,
      },
    });

    const controller = new AbortController();
    this.activeStages.set(executionId, {
      executionId,
      controller,
      nodeExecutionId: nodeExec.id,
    });

    let stageOutcome: StageOutcome;
    try {
      stageOutcome = await this.executeStage(node, renderedTask, previousOutput, controller.signal);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.deps.companyStore.updatePipelineNodeExecution(nodeExec.id, {
        status: 'failed',
        finishedAt: nowIso(),
        errorMessage: msg,
      });
      this.deps.bus.publish({
        name: 'pipeline_node_failed',
        coderSessionId: this.deps.coderSessionId,
        executionId,
        pipelineId: exec.pipeline_id,
        payload: { nodeId: node.id, error: msg },
      });
      this.detachStage(executionId, { abort: false });
      this.failExecution(executionId, exec.pipeline_id, `Node "${node.id}" threw: ${msg}`);
      return;
    }

    // pause/abort happened mid-flight — don't advance.
    const refreshed = this.deps.companyStore.getPipelineExecution(executionId);
    if (!refreshed || refreshed.status !== 'running') {
      this.detachStage(executionId, { abort: false });
      return;
    }

    // Roll usage up onto the parent chat session so the header counter
    // reflects pipeline cost.
    if (stageOutcome.usage) {
      this.deps.sessionStore.bumpUsage(
        this.deps.coderSessionId,
        stageOutcome.usage.input_tokens,
        stageOutcome.usage.output_tokens,
        stageOutcome.usage.cache_read_input_tokens ?? 0,
        stageOutcome.usage.cache_creation_input_tokens ?? 0,
      );
    }

    const branchMode: BranchMode = node.branchMode ?? 'linear';
    const verdict = resolveBranchVerdictPure({
      mode: branchMode,
      output: stageOutcome.finalText,
      verdictTokenResolver: () => stageOutcome.verdict?.verdict ?? null,
    });
    const outgoing = exec.context.snapshot.edges.filter((e) => e.from === node.id);
    const next = pickNextEdge(outgoing, branchMode, verdict);

    const updatedContext: PipelineExecutionContext = {
      snapshot: exec.context.snapshot,
      vars: {
        ...exec.context.vars,
        [node.id]: {
          output: stageOutcome.finalText,
          outcome: next?.outcome ?? branchMode,
        },
      },
    };
    this.deps.companyStore.updatePipelineNodeExecution(nodeExec.id, {
      status: 'completed',
      outputText: stageOutcome.finalText,
      outcomeBranch: next?.outcome ?? null,
      finishedAt: nowIso(),
      usageJson: stageOutcome.usage ? JSON.stringify(stageOutcome.usage) : null,
    });
    this.deps.companyStore.updatePipelineExecution(executionId, {
      context: updatedContext,
    });

    this.deps.bus.publish({
      name: 'pipeline_node_completed',
      coderSessionId: this.deps.coderSessionId,
      executionId,
      pipelineId: exec.pipeline_id,
      payload: {
        nodeId: node.id,
        outcome: next?.outcome ?? null,
        verdict: stageOutcome.verdict?.verdict ?? null,
        outputPreview: stageOutcome.finalText.slice(0, 240),
      },
    });

    this.detachStage(executionId, { abort: false });

    if (!next) {
      // No matching outgoing edge — terminal node OR misrouted condition.
      // Validator already rejects misconfiguration; treat zero-outgoing as
      // success and conditional-with-no-match as failure (so dead ends
      // surface).
      if (outgoing.length === 0) {
        this.completeExecution(executionId, exec.pipeline_id);
      } else {
        this.failExecution(
          executionId,
          exec.pipeline_id,
          `Node "${node.id}" produced no matching branch (mode=${branchMode}, verdict=${verdict ?? 'none'}).`,
        );
      }
      return;
    }

    const nextNode = exec.context.snapshot.nodes.find((n) => n.id === next.targetId);
    if (!nextNode) {
      this.failExecution(
        executionId,
        exec.pipeline_id,
        `Edge from "${node.id}" points at missing node "${next.targetId}".`,
      );
      return;
    }

    // requires_confirmation: pause AFTER this node (not before next).
    // The trick is to point `current_node_id` at the NEXT node so the
    // existing `resume()` re-runs it from a clean start. We discriminate
    // from a normal pause via `_pending_confirmation` in context.vars
    // so the dashboard can render an "Approve" button.
    if (node.requires_confirmation) {
      const ctxWithPending: PipelineExecutionContext = {
        snapshot: updatedContext.snapshot,
        vars: {
          ...updatedContext.vars,
          _pending_confirmation: {
            outcome: 'awaiting_confirmation',
            output: JSON.stringify({ from: node.id, to: nextNode.id }),
          },
        },
      };
      this.deps.companyStore.updatePipelineExecution(executionId, {
        currentNodeId: nextNode.id,
        context: ctxWithPending,
        status: 'paused',
      });
      this.deps.bus.publish({
        name: 'pipeline_paused',
        coderSessionId: this.deps.coderSessionId,
        executionId,
        pipelineId: exec.pipeline_id,
        payload: {
          nodeId: nextNode.id,
          fromNodeId: node.id,
          awaitingConfirmation: true,
        },
      });
      return;
    }

    this.deps.companyStore.updatePipelineExecution(executionId, {
      currentNodeId: nextNode.id,
    });

    void this.runNode(executionId, nextNode, initialInput, stageOutcome.finalText);
  }

  /**
   * Approve a pause caused by `requires_confirmation`. Functionally
   * identical to `resume()` for the runtime, but exists as a separate
   * verb so the dashboard's button label and the audit log read clearly.
   * Returns false when the execution isn't paused awaiting confirmation.
   */
  async confirm(executionId: number): Promise<boolean> {
    const exec = this.deps.companyStore.getPipelineExecution(executionId);
    if (!exec) return false;
    if (exec.status !== 'paused') return false;
    const pending = exec.context.vars._pending_confirmation;
    if (!pending || pending.outcome !== 'awaiting_confirmation') return false;
    // Strip the marker so a normal pause/resume after confirmation
    // doesn't keep emitting awaitingConfirmation=true.
    const cleared: PipelineExecutionContext = {
      snapshot: exec.context.snapshot,
      vars: Object.fromEntries(
        Object.entries(exec.context.vars).filter(([k]) => k !== '_pending_confirmation'),
      ),
    };
    this.deps.companyStore.updatePipelineExecution(executionId, { context: cleared });
    return this.resume(executionId);
  }

  /**
   * Build the per-stage subagent registry, resolve provider, and spawn
   * the runner. Returns `{ finalText, usage, verdict? }`.
   */
  private async executeStage(
    node: PipelineNode,
    renderedTask: string,
    previousOutput: string,
    signal: AbortSignal,
  ): Promise<StageOutcome> {
    const kind = node.kind ?? 'agent';
    const provider = await resolveStageProvider({
      node,
      defaultProvider: this.deps.defaultProvider,
      cache: this.providerCache,
    });

    const subContext: ToolContext = {
      ...this.deps.baseContext,
      signal,
      planMode: false,
    };

    if (kind === 'validate') {
      const verdictRef: VerdictRef = { verdict: null };
      const verdictTool = buildSubmitVerdictTool({ ref: verdictRef });
      // validatorTools opt-in: include any names that exist in parent
      // tools (intersection). Unknown names are silently dropped — the
      // validator carries on with submit_verdict only.
      const extraToolNames = new Set(node.validatorTools ?? []);
      const extraTools = this.deps.parentTools.filter((t) => extraToolNames.has(t.name));
      const allowlist = new Set<string>([verdictTool.name, ...extraTools.map((t) => t.name)]);
      const systemPrompt = buildValidatorSystemPrompt({
        criteria: node.validatorPrompt ?? '',
        previousOutput,
        extraToolNames: extraTools.map((t) => t.name),
      });
      const initialMessages: AgentMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: buildValidatorUserMessage({ criteria: '', previousOutput }) },
          ],
        },
      ];
      const result = await runSubagent(
        {
          provider,
          tools: [verdictTool, ...extraTools],
          ctx: subContext,
          sessionId: this.deps.coderSessionId,
          agentLoopV2: this.deps.agentLoopV2,
        },
        {
          systemPrompt,
          allowlist,
          initialMessages,
          maxTurns: node.maxAttempts ?? DEFAULT_VALIDATOR_MAX_TURNS,
        },
      );
      return {
        finalText: result.finalText,
        usage: result.usage,
        verdict: verdictRef.verdict,
      };
    }

    // kind === 'agent' — full read+write subset. The pipeline author
    // can scope this further later via per-node allowlists; for MVP we
    // give validator-free agent stages the same surface as a regular
    // implement-subagent.
    const allowlist = new Set<string>([...EXPLORE_ALLOWLIST, ...IMPLEMENT_ALLOWLIST]);
    const result = await runSubagent(
      {
        provider,
        tools: this.deps.parentTools,
        ctx: subContext,
        sessionId: this.deps.coderSessionId,
        sessionStore: this.deps.sessionStore,
        agentLoopV2: this.deps.agentLoopV2,
      },
      {
        systemPrompt: buildAgentSystemPrompt(node),
        allowlist,
        initialMessages: [
          { role: 'user', content: [{ type: 'text', text: renderedTask }] },
        ],
        maxTurns: node.maxAttempts ?? DEFAULT_AGENT_MAX_TURNS,
      },
    );
    return {
      finalText: result.finalText,
      usage: result.usage,
      verdict: null,
    };
  }

  // ─── Internal: terminal transitions ─────────────────────────────

  private completeExecution(executionId: number, pipelineId: number): void {
    this.deps.companyStore.updatePipelineExecution(executionId, {
      status: 'completed',
      finishedAt: nowIso(),
    });
    this.deps.bus.publish({
      name: 'pipeline_completed',
      coderSessionId: this.deps.coderSessionId,
      executionId,
      pipelineId,
    });
  }

  private failExecution(executionId: number, pipelineId: number, message: string): void {
    this.deps.companyStore.updatePipelineExecution(executionId, {
      status: 'failed',
      finishedAt: nowIso(),
      errorMessage: message,
    });
    this.deps.bus.publish({
      name: 'pipeline_failed',
      coderSessionId: this.deps.coderSessionId,
      executionId,
      pipelineId,
      payload: { error: message },
    });
  }

  private detachStage(executionId: number, opts: { abort: boolean }): void {
    const stage = this.activeStages.get(executionId);
    if (!stage) return;
    if (opts.abort) {
      try {
        stage.controller.abort();
      } catch {
        // best-effort
      }
    }
    this.activeStages.delete(executionId);
  }
}

interface StageOutcome {
  finalText: string;
  usage: ChatUsage;
  /** Set only when `node.kind === 'validate'` and the model called submit_verdict. */
  verdict: VerdictPayload | null;
}

function buildAgentSystemPrompt(node: PipelineNode): string {
  return `You are a PIPELINE STAGE agent ("${node.label}", role=${node.role}). The orchestrator dispatched a single, scoped task to you. Execute it, then write a concise final summary that the next stage can consume.

# Rules
1. Stay focused on this stage's task — do not start adjacent work.
2. Verify your changes when relevant (tests, lint, type-check) using run_command.
3. Your LAST assistant message is the only thing the orchestrator forwards downstream. Make it self-contained: 5–15 lines covering what was done, what files changed, and any caveat the next stage should know.
4. Do NOT call submit_plan, submit_tasks, ask_user, spawn_agent, execute_task, or task_complete — those tools are not available in pipeline stages.
5. If the task can't be completed as described, stop and report findings instead of guessing.

# Token economy
Prefer get_file_skeleton + get_symbol_body over reading whole files. Use grep_code/find_references to navigate. Avoid re-reading files you already read this turn.`;
}

function cloneGraph(g: PipelineGraph): PipelineGraph {
  return JSON.parse(JSON.stringify(g)) as PipelineGraph;
}

function lastOutputForResume(context: PipelineExecutionContext, nodeId: string): string {
  const v = context.vars[nodeId];
  if (v?.output) return v.output;
  const inEdge: PipelineEdge | undefined = context.snapshot.edges.find((e) => e.to === nodeId);
  if (inEdge) return context.vars[inEdge.from]?.output ?? '';
  return '';
}

function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}
