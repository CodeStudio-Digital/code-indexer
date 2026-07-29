/**
 * Master-only tools for the Pipeline executor.
 *
 * Lives next to `master-tools.ts` and is registered through
 * `buildMasterTools`. Subordinates never see these — pipelines are
 * orchestration concerns and only the master starts/stops them.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { okStructured } from '@mcp/code-agent/core/model-output.js';
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import { assertUuid, isUuid } from '@mcp/session-storage';
import type { PipelineId } from '@mcp/company/types.js';

export function buildPipelineMasterTools(orchestrator: CompanyOrchestrator): CoderTool[] {
  return [
    listPipelines(orchestrator),
    startPipeline(orchestrator),
    getPipelineStatus(orchestrator),
    stopPipeline(orchestrator),
  ];
}

// ─── list_pipelines ────────────────────────────────────────────

function listPipelines(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['this', 'global', 'all'],
        description: "'this' = pipelines bound to the current session + globals; 'global' = globals only; 'all' = everything visible. Default: 'all'.",
      },
    },
    required: [],
  };

  return {
    name: 'list_pipelines',
    // Auto-repeatable via `list_*` prefix.
    description:
      'List the pipelines available for this session. A pipeline is a stored graph of stages (role + task template) the master can execute via start_pipeline. Each entry returns id, name, description, scope (session-bound or global), node count, and the version number.',
    parameters,
    source: 'native',
    handler: async (args) => {
      const scope = (args.scope as 'this' | 'global' | 'all' | undefined) ?? 'all';
      const items = await orchestrator.pipelineList({ scope });
      const summary = items.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        scope: p.company_session_id == null ? 'global' : 'session',
        nodes: p.graph.nodes.length,
        edges: p.graph.edges.length,
        version: p.version,
        updated_at: p.updated_at,
      }));
      if (summary.length === 0) {
        return ok('No pipelines available. Create one via the dashboard Pipelines tab, then call start_pipeline.');
      }
      return okStructured(summary);
    },
  };
}

// ─── start_pipeline ────────────────────────────────────────────

function startPipeline(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      pipeline_id: {
        oneOf: [{ type: 'number' }, { type: 'string', format: 'uuid' }],
        description:
          'Pipeline id from list_pipelines: numeric for reusable/project definitions, UUID for Company-session definitions.',
      },
      initial_input: {
        type: 'string',
        description:
          'Initial payload for the first node. Becomes {{initial_input}} in the start node\'s task template. Should be a synthesised brief, not the raw user message.',
      },
    },
    required: ['pipeline_id', 'initial_input'],
  };

  return {
    name: 'start_pipeline',
    description:
      'Execute a pipeline end-to-end. The executor spawns a subordinate per stage, creates Kanban cards, advances along linear edges, and reports progress through SSE events. Returns the execution id — use get_pipeline_status to inspect node-by-node progress.',
    parameters,
    source: 'native',
    handler: async (args) => {
      const pipelineId = parsePipelineId(args.pipeline_id);
      const initialInput = String(args.initial_input ?? '');
      try {
        const pipeline = await orchestrator.pipelineGet(pipelineId);
        if (!pipeline) return err(`Pipeline ${pipelineId} not found. Use list_pipelines to see available ids.`);

        const validation = orchestrator.pipelineValidate(pipeline.graph);
        if (!validation.ok) {
          const details = validation.errors.map((e) => `  - ${e.nodeId ? `node ${e.nodeId}: ` : e.edgeId ? `edge ${e.edgeId}: ` : ''}${e.message}`).join('\n');
          return err(`Pipeline ${pipelineId} (${pipeline.name}) is invalid:\n${details}\nFix it in the Pipelines tab before running.`);
        }

        const exec = await orchestrator.pipelineStart(pipelineId, initialInput, 'master');
        return okStructured({
          execution_id: exec.id,
          pipeline_id: exec.pipeline_id,
          status: exec.status,
          start_node: exec.current_node_id,
        });
      } catch (e) {
        return err(`Failed to start pipeline: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

function parsePipelineId(raw: unknown): PipelineId {
  if (
    typeof raw === 'number' &&
    Number.isSafeInteger(raw) &&
    raw > 0
  ) {
    return raw;
  }
  if (typeof raw === 'string' && isUuid(raw)) {
    return assertUuid(raw, 'pipeline_id');
  }
  throw new TypeError('pipeline_id must be a positive integer or UUID');
}

// ─── get_pipeline_status ───────────────────────────────────────

function getPipelineStatus(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      execution_id: { type: 'string', description: 'Pipeline execution UUID returned by start_pipeline.' },
    },
    required: ['execution_id'],
  };

  return {
    name: 'get_pipeline_status',
    // Auto-repeatable via `_status` suffix.
    description:
      'Inspect a running or finished pipeline execution. Returns the execution row plus all node executions with status, attempt, kanban_card_id and a short output preview. Useful while a long pipeline is in flight.',
    parameters,
    source: 'native',
    handler: async (args) => {
      const id = assertUuid(String(args.execution_id), 'execution_id');
      const result = await orchestrator.pipelineStatus(id);
      if (!result) return err(`Pipeline execution ${id} not found.`);
      const compact = {
        execution: {
          id: result.execution.id,
          pipeline_id: result.execution.pipeline_id,
          status: result.execution.status,
          current_node_id: result.execution.current_node_id,
          started_at: result.execution.started_at,
          finished_at: result.execution.finished_at,
          error: result.execution.error_message,
        },
        nodes: result.nodes.map((n) => ({
          node_id: n.node_id,
          label: n.node_label,
          role: n.role,
          status: n.status,
          attempt: n.attempt,
          agent_run_id: n.agent_run_id,
          kanban_card_id: n.kanban_card_id,
          output_preview: (n.output_text ?? '').slice(0, 240),
          error: n.error_message,
          finished_at: n.finished_at,
        })),
      };
      return okStructured(compact);
    },
  };
}

// ─── stop_pipeline ─────────────────────────────────────────────

function stopPipeline(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      execution_id: { type: 'string', description: 'Pipeline execution UUID to abort.' },
      reason: { type: 'string', description: 'Optional human-readable reason recorded on the execution row.' },
    },
    required: ['execution_id'],
  };

  return {
    name: 'stop_pipeline',
    description:
      'Abort a running pipeline execution. Aborts the subordinate currently working on the active node and marks the execution as aborted. Idempotent for already-finished executions.',
    parameters,
    source: 'native',
    handler: async (args) => {
      const id = assertUuid(String(args.execution_id), 'execution_id');
      const reason = args.reason as string | undefined;
      const ok2 = await orchestrator.pipelineAbort(id, reason);
      if (!ok2) return err(`Pipeline execution ${id} is not abortable (not found or already terminal).`);
      return ok(`Pipeline execution ${id} aborted${reason ? `: ${reason}` : ''}.`);
    },
  };
}
