import {
  CompanySessionRepository,
  assertUuid,
  type CompanyPipelineNodeExecutionData,
  type EntityRecord,
} from '@mcp/session-storage';
import type { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';
import type {
  PipelineNodeExecution,
  PipelineNodeStatus,
} from '@mcp/company/types.js';
import { locate as locateExecution } from './pipeline-executions.js';

export interface CreateNodeExecutionInput {
  executionId: string;
  nodeId: string;
  nodeLabel: string;
  role: string;
  inputText: string;
  attempt?: number;
  agentRunId?: string | null;
  kanbanCardId?: string | null;
  coderSessionId?: string | null;
}

export interface UpdateNodeExecutionPatch {
  status?: PipelineNodeStatus;
  agentRunId?: string | null;
  kanbanCardId?: string | null;
  coderSessionId?: string | null;
  outputText?: string | null;
  outcomeBranch?: string | null;
  finishedAt?: string | null;
  errorMessage?: string | null;
  usageJson?: string | null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nodeStatus(value: unknown): PipelineNodeStatus {
  return value === 'pending' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'skipped' ||
    value === 'aborted'
    ? value
    : 'running';
}

function hydrate(
  record: EntityRecord<CompanyPipelineNodeExecutionData>,
): PipelineNodeExecution {
  const data = record.data;
  return {
    id: assertUuid(record.id, 'pipeline node execution id'),
    seq: record.seq,
    execution_id: assertUuid(
      String(data.execution_id),
      'pipeline execution id',
    ),
    node_id: typeof data.node_id === 'string' ? data.node_id : '',
    node_label:
      typeof data.node_label === 'string' ? data.node_label : '',
    role: typeof data.role === 'string' ? data.role : '',
    status: nodeStatus(data.status),
    agent_run_id: nullableString(data.agent_run_id),
    kanban_card_id: nullableString(data.kanban_card_id),
    coder_session_id: nullableString(data.coder_session_id),
    input_text:
      typeof data.input_text === 'string' ? data.input_text : '',
    output_text: nullableString(data.output_text),
    outcome_branch: nullableString(data.outcome_branch),
    attempt:
      typeof data.attempt === 'number' ? data.attempt : 1,
    started_at: nullableString(data.started_at),
    finished_at: nullableString(data.finished_at),
    error_message: nullableString(data.error_message),
    usage_json: nullableString(data.usage_json),
  };
}

export async function create(
  store: FsSessionStore,
  input: CreateNodeExecutionInput,
): Promise<PipelineNodeExecution> {
  const execution = await locateExecution(store, input.executionId);
  if (!execution) {
    throw new Error(`Unknown pipeline execution ${input.executionId}`);
  }
  const now = new Date().toISOString();
  const record = await store.runSessionMutation(
    execution.entry.session.id,
    () =>
      execution.repository.createPipelineNodeExecution({
        relations: {
          execution_id: assertUuid(
            input.executionId,
            'pipeline execution id',
          ),
          ...(input.agentRunId
            ? {
                agent_run_id: assertUuid(
                  input.agentRunId,
                  'pipeline agent run id',
                ),
              }
            : {}),
          ...(input.kanbanCardId
            ? {
                kanban_card_id: assertUuid(
                  input.kanbanCardId,
                  'pipeline Kanban card id',
                ),
              }
            : {}),
          ...(input.coderSessionId
            ? {
                coder_session_id: assertUuid(
                  input.coderSessionId,
                  'pipeline coder session id',
                ),
              }
            : {}),
        },
        data: {
          execution_id: input.executionId,
          node_id: input.nodeId,
          node_label: input.nodeLabel,
          role: input.role,
          status: 'running',
          agent_run_id: input.agentRunId ?? null,
          kanban_card_id: input.kanbanCardId ?? null,
          coder_session_id: input.coderSessionId ?? null,
          input_text: input.inputText,
          output_text: null,
          outcome_branch: null,
          attempt: input.attempt ?? 1,
          started_at: now,
          finished_at: null,
          error_message: null,
          usage_json: null,
        },
      }),
  );
  return hydrate(record);
}

export async function get(
  store: FsSessionStore,
  id: string,
): Promise<PipelineNodeExecution | null> {
  const normalized = assertUuid(id, 'pipeline node execution id');
  for (const entry of store.catalog.list()) {
    const repository = new CompanySessionRepository({
      sessionRoot: entry.location.bundle_path,
    });
    const record = await repository.get(
      'pipelineNodeExecution',
      normalized,
    );
    if (record) return hydrate(record);
  }
  return null;
}

export async function list(
  store: FsSessionStore,
  executionId: string,
): Promise<PipelineNodeExecution[]> {
  const execution = await locateExecution(store, executionId);
  if (!execution) return [];
  const records: EntityRecord<CompanyPipelineNodeExecutionData>[] = [];
  let cursor: string | undefined;
  do {
    const page = await execution.repository.listByRelation(
      'pipelineNodeExecution',
      'execution_id',
      assertUuid(executionId, 'pipeline execution id'),
      { cursor, limit: 1_000, order: 'asc' },
    );
    records.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return records.map(hydrate);
}

export async function update(
  store: FsSessionStore,
  id: string,
  patch: UpdateNodeExecutionPatch,
): Promise<PipelineNodeExecution | null> {
  const normalized = assertUuid(id, 'pipeline node execution id');
  for (const entry of store.catalog.list()) {
    const repository = new CompanySessionRepository({
      sessionRoot: entry.location.bundle_path,
    });
    const current = await repository.get(
      'pipelineNodeExecution',
      normalized,
    );
    if (!current) continue;
    const updated = await store.runSessionMutation(
      entry.session.id,
      async () => {
        const latest = await repository.get(
          'pipelineNodeExecution',
          normalized,
        );
        if (!latest) return null;
        const agentRunId =
          patch.agentRunId === undefined
            ? nullableString(latest.data.agent_run_id)
            : patch.agentRunId;
        const kanbanCardId =
          patch.kanbanCardId === undefined
            ? nullableString(latest.data.kanban_card_id)
            : patch.kanbanCardId;
        const coderSessionId =
          patch.coderSessionId === undefined
            ? nullableString(latest.data.coder_session_id)
            : patch.coderSessionId;
        return repository.update(
          'pipelineNodeExecution',
          normalized,
          {
            relations: {
              execution_id: assertUuid(
                String(latest.data.execution_id),
                'pipeline execution id',
              ),
              ...(agentRunId
                ? { agent_run_id: assertUuid(agentRunId) }
                : {}),
              ...(kanbanCardId
                ? { kanban_card_id: assertUuid(kanbanCardId) }
                : {}),
              ...(coderSessionId
                ? { coder_session_id: assertUuid(coderSessionId) }
                : {}),
            },
            data: {
              ...latest.data,
              ...(patch.status !== undefined
                ? { status: patch.status }
                : {}),
              ...(patch.agentRunId !== undefined
                ? { agent_run_id: patch.agentRunId }
                : {}),
              ...(patch.kanbanCardId !== undefined
                ? { kanban_card_id: patch.kanbanCardId }
                : {}),
              ...(patch.coderSessionId !== undefined
                ? { coder_session_id: patch.coderSessionId }
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
            },
          },
        );
      },
    );
    return updated ? hydrate(updated) : null;
  }
  return null;
}
