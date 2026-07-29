/**
 * ChatPipelineExecutor — orchestrates a pipeline graph owned by a
 * filesystem session bundle (the chat pipeline mode).
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
 * Templates remain in CompanyStore, while every execution and node state
 * is persisted as an independent entity in the owner session's `company/`
 * directory. No operational pipeline state touches SQLite.
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
import type {
  FsChatPipelineExecution,
  FsChatPipelineNodeExecution,
  FsSessionStore,
} from '@mcp/code-agent/sessions/fs-store/index.js';
import type { SessionId } from '@mcp/session-storage';
import type {
  Pipeline,
  PipelineEdge,
  PipelineExecutionContext,
  PipelineExecutionStatus,
  PipelineGraph,
  PipelineNode,
} from '@mcp/company-contracts';

const DEFAULT_NODE_MAX_ATTEMPTS = 3;
const GLOBAL_NODE_EXECUTION_CAP = 50;
const DEFAULT_AGENT_MAX_TURNS = 60;
const DEFAULT_VALIDATOR_MAX_TURNS = 6;

export interface ChatPipelineExecutorDeps {
  /** Owner chat session — published on every event and stored on every row. */
  coderSessionId: SessionId;
  /** Default provider for stages without `model_override`. */
  defaultProvider: ChatProvider;
  /** Tools the parent chat session has registered. Filtered per-stage. */
  parentTools: CoderTool[];
  /** Tool context inherited by each stage subagent (cwd, overlay, etc.). */
  baseContext: Pick<ToolContext, 'cwd' | 'projectName' | 'overlay'>;
  sessionStore: FsSessionStore;
  companyStore: {
    getPipeline(id: number): Pipeline | null | Promise<Pipeline | null>;
  };
  bus: ChatPipelineBus;
  /** Optional V2 framing flag, propagated to each stage's runSubagent. */
  agentLoopV2?: boolean;
}

interface ActiveStage {
  executionId: string;
  controller: AbortController;
  nodeExecutionId: string;
}

type ChatPipelineExecution =
  FsChatPipelineExecution<PipelineExecutionContext>;

export class ChatPipelineExecutor {
  /** Per-execution AbortController so pause/abort can interrupt the running stage. */
  private readonly activeStages = new Map<string, ActiveStage>();
  /** Provider cache lives per-executor; identical (provider, model) pairs reuse instances. */
  private readonly providerCache: ProviderCache = makeProviderCache();

  constructor(private readonly deps: ChatPipelineExecutorDeps) {}

  // ─── Public API (mirrors company executor) ──────────────────────

  async start(
    pipelineId: number,
    initialInput: string,
    startedBy = 'user',
  ): Promise<ChatPipelineExecution> {
    const pipeline = await this.deps.companyStore.getPipeline(pipelineId);
    if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found.`);

    const startNode = resolveStartNode(pipeline.graph);
    if (!startNode) throw new Error(`Pipeline ${pipelineId} has no resolvable start node.`);

    const context: PipelineExecutionContext = {
      snapshot: cloneGraph(pipeline.graph),
      vars: {},
    };

    const owner = await this.deps.sessionStore.getSession(
      this.deps.coderSessionId,
    );
    if (!owner) {
      throw new Error(
        `Session ${this.deps.coderSessionId} not found.`,
      );
    }
    const execution =
      await this.deps.sessionStore.chatPipelines.createExecution({
        session_id: this.deps.coderSessionId,
        pipeline_id: pipelineId,
        project_id: owner.project_id,
        initial_input: initialInput,
        context,
        started_by: startedBy,
        current_node_id: startNode.id,
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

  async abort(executionId: string, reason?: string): Promise<boolean> {
    const exec =
      await this.deps.sessionStore.chatPipelines
        .getExecution<PipelineExecutionContext>(
      this.deps.coderSessionId,
      executionId,
    );
    if (!exec) return false;
    if (exec.status !== 'running' && exec.status !== 'paused') return false;

    this.detachStage(executionId, { abort: true });

    await this.deps.sessionStore.chatPipelines.updateExecution(
      this.deps.coderSessionId,
      executionId,
      {
      status: 'aborted',
      finishedAt: nowIso(),
      errorMessage: reason ?? null,
      },
    );

    this.deps.bus.publish({
      name: 'pipeline_aborted',
      coderSessionId: this.deps.coderSessionId,
      executionId,
      pipelineId: exec.pipeline_id,
      payload: { reason: reason ?? null },
    });
    return true;
  }

  async pause(executionId: string): Promise<boolean> {
    const exec =
      await this.deps.sessionStore.chatPipelines
        .getExecution<PipelineExecutionContext>(
      this.deps.coderSessionId,
      executionId,
    );
    if (!exec) return false;
    if (exec.status !== 'running') return false;

    const stage = this.activeStages.get(executionId);
    let pausedNodeRowId: string | null = null;
    if (stage) {
      pausedNodeRowId = stage.nodeExecutionId;
      await this.deps.sessionStore.chatPipelines.updateNodeExecution(
        this.deps.coderSessionId,
        stage.nodeExecutionId,
        {
          status: 'aborted',
          finishedAt: nowIso(),
          errorMessage: 'paused by operator',
        },
      );
    }
    this.detachStage(executionId, { abort: true });

    await this.deps.sessionStore.chatPipelines.updateExecution(
      this.deps.coderSessionId,
      executionId,
      { status: 'paused' },
    );
    this.deps.bus.publish({
      name: 'pipeline_paused',
      coderSessionId: this.deps.coderSessionId,
      executionId,
      pipelineId: exec.pipeline_id,
      payload: { nodeId: exec.current_node_id, pausedNodeExecutionId: pausedNodeRowId },
    });
    return true;
  }

  async resume(executionId: string): Promise<boolean> {
    const exec =
      await this.deps.sessionStore.chatPipelines
        .getExecution<PipelineExecutionContext>(
      this.deps.coderSessionId,
      executionId,
    );
    if (!exec) return false;
    if (exec.status !== 'paused') return false;

    const node = exec.current_node_id
      ? exec.context.snapshot.nodes.find((n) => n.id === exec.current_node_id)
      : null;
    if (!node) {
      await this.failExecution(executionId, exec.pipeline_id, 'Resume failed: current_node_id is missing or unknown.');
      return false;
    }

    await this.deps.sessionStore.chatPipelines.updateExecution(
      this.deps.coderSessionId,
      executionId,
      { status: 'running' },
    );
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

  async status(executionId: string): Promise<{
    execution: ChatPipelineExecution;
    nodes: FsChatPipelineNodeExecution[];
  } | null> {
    const execution =
      await this.deps.sessionStore.chatPipelines
        .getExecution<PipelineExecutionContext>(
      this.deps.coderSessionId,
      executionId,
    );
    if (!execution) return null;
    const nodes =
      await this.deps.sessionStore.chatPipelines.listNodeExecutions(
        this.deps.coderSessionId,
        executionId,
      );
    return { execution, nodes };
  }

  listExecutions(opts?: {
    pipelineId?: number;
    status?: PipelineExecutionStatus;
    limit?: number;
  }): Promise<ChatPipelineExecution[]> {
    return this.deps.sessionStore.chatPipelines
      .listExecutions<PipelineExecutionContext>(
        this.deps.coderSessionId,
        {
          pipeline_id: opts?.pipelineId,
          status: opts?.status,
          limit: opts?.limit,
        },
      );
  }

  /**
   * After a process restart, in-memory subagents are gone. Flip any
   * still-`running` chat-pipeline execution to `paused` so the user can
   * decide whether to resume — same semantics as the company executor.
   */
  async recoverRunning(): Promise<{ paused: number }> {
    const running =
      await this.deps.sessionStore.chatPipelines
        .listExecutions<PipelineExecutionContext>(
        this.deps.coderSessionId,
        { status: 'running' },
      );
    let paused = 0;
    for (const exec of running) {
      const rows =
        await this.deps.sessionStore.chatPipelines.listNodeExecutions(
          this.deps.coderSessionId,
          exec.id,
        );
      const last = rows[rows.length - 1];
      if (last && last.status === 'running') {
        await this.deps.sessionStore.chatPipelines.updateNodeExecution(
          this.deps.coderSessionId,
          last.id,
          {
            status: 'aborted',
            finishedAt: nowIso(),
            errorMessage: 'server restart — subagent no longer alive',
          },
        );
      }
      await this.deps.sessionStore.chatPipelines.updateExecution(
        this.deps.coderSessionId,
        exec.id,
        { status: 'paused' },
      );
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
    executionId: string,
    node: PipelineNode,
    initialInput: string,
    previousOutput: string,
  ): Promise<void> {
    const exec =
      await this.deps.sessionStore.chatPipelines
        .getExecution<PipelineExecutionContext>(
      this.deps.coderSessionId,
      executionId,
    );
    if (!exec || exec.status !== 'running') return;

    // Global cap defends against pathological cycles that escape the
    // per-node `maxAttempts` guard (e.g. wide fan-out with rotating
    // verdicts).
    const allRows =
      await this.deps.sessionStore.chatPipelines.listNodeExecutions(
        this.deps.coderSessionId,
        executionId,
      );
    if (allRows.length >= GLOBAL_NODE_EXECUTION_CAP) {
      await this.failExecution(
        executionId,
        exec.pipeline_id,
        `Aborted after ${GLOBAL_NODE_EXECUTION_CAP} node executions (global cycle cap).`,
      );
      return;
    }

    const previousAttemptsForNode = allRows.filter((r) => r.node_id === node.id).length;
    const maxAttempts = Math.max(1, node.maxAttempts ?? DEFAULT_NODE_MAX_ATTEMPTS);
    if (previousAttemptsForNode >= maxAttempts) {
      await this.failExecution(
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

    const nodeExec =
      await this.deps.sessionStore.chatPipelines.createNodeExecution({
      session_id: this.deps.coderSessionId,
      execution_id: executionId,
      node_id: node.id,
      node_label: node.label,
      role: node.role,
      input_text: renderedTask,
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
      await this.deps.sessionStore.chatPipelines.updateNodeExecution(
        this.deps.coderSessionId,
        nodeExec.id,
        {
          status: 'failed',
          finishedAt: nowIso(),
          errorMessage: msg,
        },
      );
      this.deps.bus.publish({
        name: 'pipeline_node_failed',
        coderSessionId: this.deps.coderSessionId,
        executionId,
        pipelineId: exec.pipeline_id,
        payload: { nodeId: node.id, error: msg },
      });
      this.detachStage(executionId, { abort: false });
      await this.failExecution(executionId, exec.pipeline_id, `Node "${node.id}" threw: ${msg}`);
      return;
    }

    // pause/abort happened mid-flight — don't advance.
    const refreshed =
      await this.deps.sessionStore.chatPipelines
        .getExecution<PipelineExecutionContext>(
        this.deps.coderSessionId,
        executionId,
      );
    if (!refreshed || refreshed.status !== 'running') {
      this.detachStage(executionId, { abort: false });
      return;
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
    await this.deps.sessionStore.chatPipelines.updateNodeExecution(
      this.deps.coderSessionId,
      nodeExec.id,
      {
        status: 'completed',
        outputText: stageOutcome.finalText,
        outcomeBranch: next?.outcome ?? null,
        finishedAt: nowIso(),
        usageJson: stageOutcome.usage
          ? JSON.stringify(stageOutcome.usage)
          : null,
      },
    );
    await this.deps.sessionStore.chatPipelines.updateExecution(
      this.deps.coderSessionId,
      executionId,
      { context: updatedContext },
    );

    // First-class: mirror the stage output into the chat transcript as a
    // real assistant turn so the conversation isn't empty, the user can
    // continue with context, and the session's Mensagens/Turnos counters
    // reflect the pipeline. The immutable turn metric carries the stage usage,
    // so global totals are rebuilt from files rather than a side counter.
    try {
      await this.deps.sessionStore.persistAssistantTurn({
        session_id: this.deps.coderSessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `**Pipeline · ${node.label}**\n\n${stageOutcome.finalText}` }],
        },
        usage: stageOutcome.usage,
        tool_calls: [],
      });
    } catch (e) {
      console.warn('[pipeline] persist stage message failed:', e);
    }

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
      // Zero outgoing → terminal node, completed.
      if (outgoing.length === 0) {
        await this.completeExecution(executionId, exec.pipeline_id);
        return;
      }
      // 'review' verdict with no 'review' edge: pause for HUMAN review
      // instead of failing the run. Approving continues down the 'pass'
      // edge (optimistic); aborting stops. Reuses the confirmation gate.
      if (branchMode === 'pass-fail' && verdict === 'review') {
        const passEdge = pickNextEdge(outgoing, 'pass-fail', 'pass');
        const passNode = passEdge
          ? exec.context.snapshot.nodes.find((n) => n.id === passEdge.targetId)
          : null;
        if (passNode) {
          const ctxReview: PipelineExecutionContext = {
            snapshot: updatedContext.snapshot,
            vars: {
              ...updatedContext.vars,
              _pending_confirmation: {
                outcome: 'awaiting_confirmation',
                output: JSON.stringify({ from: node.id, to: passNode.id, review: true }),
              },
            },
          };
          await this.deps.sessionStore.chatPipelines.updateExecution(
            this.deps.coderSessionId,
            executionId,
            {
              currentNodeId: passNode.id,
              context: ctxReview,
              status: 'paused',
            },
          );
          this.deps.bus.publish({
            name: 'pipeline_paused',
            coderSessionId: this.deps.coderSessionId,
            executionId,
            pipelineId: exec.pipeline_id,
            payload: { nodeId: passNode.id, fromNodeId: node.id, awaitingConfirmation: true, review: true },
          });
          return;
        }
      }
      // Genuine dead-end — surface an actionable message (which edge to add).
      await this.failExecution(
        executionId,
        exec.pipeline_id,
        `Node "${node.id}" has no '${verdict ?? branchMode}' edge (mode=${branchMode}). Add an outgoing '${verdict ?? ''}' edge from "${node.id}" in the builder.`,
      );
      return;
    }

    const nextNode = exec.context.snapshot.nodes.find((n) => n.id === next.targetId);
    if (!nextNode) {
      await this.failExecution(
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
      await this.deps.sessionStore.chatPipelines.updateExecution(
        this.deps.coderSessionId,
        executionId,
        {
          currentNodeId: nextNode.id,
          context: ctxWithPending,
          status: 'paused',
        },
      );
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

    await this.deps.sessionStore.chatPipelines.updateExecution(
      this.deps.coderSessionId,
      executionId,
      { currentNodeId: nextNode.id },
    );

    void this.runNode(executionId, nextNode, initialInput, stageOutcome.finalText);
  }

  /**
   * Approve a pause caused by `requires_confirmation`. Functionally
   * identical to `resume()` for the runtime, but exists as a separate
   * verb so the dashboard's button label and the audit log read clearly.
   * Returns false when the execution isn't paused awaiting confirmation.
   */
  async confirm(executionId: string): Promise<boolean> {
    const exec =
      await this.deps.sessionStore.chatPipelines
        .getExecution<PipelineExecutionContext>(
      this.deps.coderSessionId,
      executionId,
    );
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
    await this.deps.sessionStore.chatPipelines.updateExecution(
      this.deps.coderSessionId,
      executionId,
      { context: cleared },
    );
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
          sessionStore: this.deps.sessionStore,
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

  private async completeExecution(
    executionId: string,
    pipelineId: number,
  ): Promise<void> {
    await this.deps.sessionStore.chatPipelines.updateExecution(
      this.deps.coderSessionId,
      executionId,
      {
        status: 'completed',
        finishedAt: nowIso(),
      },
    );
    this.deps.bus.publish({
      name: 'pipeline_completed',
      coderSessionId: this.deps.coderSessionId,
      executionId,
      pipelineId,
    });
  }

  private async failExecution(
    executionId: string,
    pipelineId: number,
    message: string,
  ): Promise<void> {
    await this.deps.sessionStore.chatPipelines.updateExecution(
      this.deps.coderSessionId,
      executionId,
      {
        status: 'failed',
        finishedAt: nowIso(),
        errorMessage: message,
      },
    );
    this.deps.bus.publish({
      name: 'pipeline_failed',
      coderSessionId: this.deps.coderSessionId,
      executionId,
      pipelineId,
      payload: { error: message },
    });
  }

  private detachStage(executionId: string, opts: { abort: boolean }): void {
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
  return new Date().toISOString();
}
