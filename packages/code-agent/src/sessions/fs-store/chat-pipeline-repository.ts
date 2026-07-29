import {
  newSessionId,
  type JsonValue,
  type ProjectId,
  type SessionId,
} from '@mcp/session-storage';
import {
  FsSessionEntityFiles,
  type FsEntityEnvelope,
} from './entity-files.js';

export type FsChatPipelineExecutionStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'aborted';

export type FsChatPipelineNodeStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'aborted';

export interface FsChatPipelineExecution<TContext = JsonValue> {
  id: string;
  seq: number;
  revision: number;
  pipeline_id: number;
  project_id: ProjectId | null;
  coder_session_id: SessionId;
  status: FsChatPipelineExecutionStatus;
  current_node_id: string | null;
  initial_input: string;
  context: TContext;
  started_by: string;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
}

export interface FsChatPipelineNodeExecution {
  id: string;
  seq: number;
  revision: number;
  execution_id: string;
  node_id: string;
  node_label: string;
  role: string;
  status: FsChatPipelineNodeStatus;
  input_text: string;
  output_text: string | null;
  outcome_branch: string | null;
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  usage_json: string | null;
}

interface ExecutionData
  extends Omit<
    FsChatPipelineExecution<JsonValue>,
    'id' | 'seq' | 'revision'
  > {}

interface NodeExecutionData
  extends Omit<
    FsChatPipelineNodeExecution,
    'id' | 'seq' | 'revision'
  > {
  coder_session_id: SessionId;
}

function executionRow<TContext = JsonValue>(
  item: FsEntityEnvelope<JsonValue>,
): FsChatPipelineExecution<TContext> {
  return {
    id: item.id,
    seq: item.seq,
    revision: item.revision,
    ...(item.data as unknown as Omit<
      FsChatPipelineExecution<TContext>,
      'id' | 'seq' | 'revision'
    >),
  };
}

function nodeRow(
  item: FsEntityEnvelope<JsonValue>,
): FsChatPipelineNodeExecution {
  const data = item.data as unknown as NodeExecutionData;
  return {
    id: item.id,
    seq: item.seq,
    revision: item.revision,
    execution_id: data.execution_id,
    node_id: data.node_id,
    node_label: data.node_label,
    role: data.role,
    status: data.status,
    input_text: data.input_text,
    output_text: data.output_text,
    outcome_branch: data.outcome_branch,
    attempt: data.attempt,
    started_at: data.started_at,
    finished_at: data.finished_at,
    error_message: data.error_message,
    usage_json: data.usage_json,
  };
}

export class FsChatPipelineRepository {
  constructor(private readonly entities: FsSessionEntityFiles) {}

  async createExecution<TContext>(input: {
    session_id: SessionId;
    pipeline_id: number;
    project_id: ProjectId | null;
    initial_input: string;
    context: TContext;
    started_by: string;
    current_node_id: string;
  }): Promise<FsChatPipelineExecution<TContext>> {
    const now = new Date().toISOString();
    const created = await this.entities.create(
      input.session_id,
      'company',
      {
        kind: 'chat_pipeline_execution',
        data: {
          pipeline_id: input.pipeline_id,
          project_id: input.project_id,
          coder_session_id: input.session_id,
          status: 'running',
          current_node_id: input.current_node_id,
          initial_input: input.initial_input,
          context: input.context as unknown as JsonValue,
          started_by: input.started_by,
          started_at: now,
          finished_at: null,
          error_message: null,
        } satisfies ExecutionData,
        operation_id:
          `chat-pipeline:${newSessionId()}:create-execution`,
      },
    );
    return executionRow<TContext>(created);
  }

  async getExecution<TContext = JsonValue>(
    sessionId: SessionId | string,
    executionId: string,
  ): Promise<FsChatPipelineExecution<TContext> | null> {
    const found = await this.entities.get<JsonValue>(
      sessionId,
      'company',
      executionId,
    );
    return found?.kind === 'chat_pipeline_execution'
      ? executionRow<TContext>(found)
      : null;
  }

  async listExecutions<TContext = JsonValue>(
    sessionId: SessionId | string,
    options: {
      pipeline_id?: number;
      status?: FsChatPipelineExecutionStatus;
      limit?: number;
    } = {},
  ): Promise<FsChatPipelineExecution<TContext>[]> {
    return (await this.entities.list<JsonValue>(
      sessionId,
      'company',
      'chat_pipeline_execution',
    ))
      .map((item) => executionRow<TContext>(item))
      .filter(
        (item) =>
          options.pipeline_id == null ||
          item.pipeline_id === options.pipeline_id,
      )
      .filter(
        (item) =>
          options.status == null || item.status === options.status,
      )
      .sort(
        (left, right) =>
          Date.parse(right.started_at) -
            Date.parse(left.started_at) ||
          right.seq - left.seq,
      )
      .slice(0, Math.max(0, options.limit ?? 100));
  }

  async updateExecution<TContext = JsonValue>(
    sessionId: SessionId | string,
    executionId: string,
    patch: {
      status?: FsChatPipelineExecutionStatus;
      currentNodeId?: string | null;
      context?: TContext;
      finishedAt?: string | null;
      errorMessage?: string | null;
    },
  ): Promise<FsChatPipelineExecution<TContext> | null> {
    const updated = await this.entities.update<ExecutionData>(
      sessionId,
      'company',
      executionId,
      (current) => ({
        ...current,
        ...(patch.status !== undefined
          ? { status: patch.status }
          : {}),
        ...(patch.currentNodeId !== undefined
          ? { current_node_id: patch.currentNodeId }
          : {}),
        ...(patch.context !== undefined
          ? { context: patch.context as unknown as JsonValue }
          : {}),
        ...(patch.finishedAt !== undefined
          ? { finished_at: patch.finishedAt }
          : {}),
        ...(patch.errorMessage !== undefined
          ? { error_message: patch.errorMessage }
          : {}),
      }),
      {
        operation_id:
          `chat-pipeline:${executionId}:update:${newSessionId()}`,
        operation_key: { action: 'update_execution', patch },
      },
    );
    return updated ? executionRow<TContext>(updated) : null;
  }

  async createNodeExecution(input: {
    session_id: SessionId;
    execution_id: string;
    node_id: string;
    node_label: string;
    role: string;
    input_text: string;
    attempt: number;
  }): Promise<FsChatPipelineNodeExecution> {
    const now = new Date().toISOString();
    const created = await this.entities.create(
      input.session_id,
      'company',
      {
        kind: 'chat_pipeline_node_execution',
        data: {
          coder_session_id: input.session_id,
          execution_id: input.execution_id,
          node_id: input.node_id,
          node_label: input.node_label,
          role: input.role,
          status: 'running',
          input_text: input.input_text,
          output_text: null,
          outcome_branch: null,
          attempt: input.attempt,
          started_at: now,
          finished_at: null,
          error_message: null,
          usage_json: null,
        } satisfies NodeExecutionData,
        operation_id:
          `chat-pipeline-node:${input.execution_id}:${input.node_id}:${input.attempt}`,
      },
    );
    return nodeRow(created);
  }

  async listNodeExecutions(
    sessionId: SessionId | string,
    executionId: string,
  ): Promise<FsChatPipelineNodeExecution[]> {
    return (await this.entities.list<JsonValue>(
      sessionId,
      'company',
      'chat_pipeline_node_execution',
    ))
      .map(nodeRow)
      .filter((item) => item.execution_id === executionId)
      .sort((left, right) => left.seq - right.seq);
  }

  async updateNodeExecution(
    sessionId: SessionId | string,
    nodeExecutionId: string,
    patch: {
      status?: FsChatPipelineNodeStatus;
      outputText?: string | null;
      outcomeBranch?: string | null;
      finishedAt?: string | null;
      errorMessage?: string | null;
      usageJson?: string | null;
    },
  ): Promise<FsChatPipelineNodeExecution | null> {
    const updated = await this.entities.update<NodeExecutionData>(
      sessionId,
      'company',
      nodeExecutionId,
      (current) => ({
        ...current,
        ...(patch.status !== undefined
          ? { status: patch.status }
          : {}),
        ...(patch.outputText !== undefined
          ? { output_text: patch.outputText }
          : {}),
        ...(patch.outcomeBranch !== undefined
          ? { outcome_branch: patch.outcomeBranch }
          : {}),
        ...(patch.finishedAt !== undefined
          ? { finished_at: patch.finishedAt }
          : {}),
        ...(patch.errorMessage !== undefined
          ? { error_message: patch.errorMessage }
          : {}),
        ...(patch.usageJson !== undefined
          ? { usage_json: patch.usageJson }
          : {}),
      }),
      {
        operation_id:
          `chat-pipeline-node:${nodeExecutionId}:update:${newSessionId()}`,
        operation_key: { action: 'update_node_execution', patch },
      },
    );
    return updated ? nodeRow(updated) : null;
  }
}
