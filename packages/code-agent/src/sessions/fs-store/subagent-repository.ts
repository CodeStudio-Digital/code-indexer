import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import {
  asAgentRunId,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import { FsSessionEntityFiles, type FsEntityEnvelope } from './entity-files.js';
import { FsSessionDirectory } from './session-directory.js';
import { FsSubagentResultRepository } from './subagent-result-repository.js';
import type {
  FsCompleteSubagentRunInput,
  FsStartSubagentRunInput,
  FsSubagentRunFence,
  FsSubagentRunPage,
  FsSubagentToolCallInput,
  FsWorkflowStepRunReconciliation,
  SubagentRunData,
  SubagentToolCallData,
} from './subagent-types.js';
import {
  optionalAgentRunId,
  validatedFence,
  validatedRunData,
  validatedUuid,
} from './subagent-validation.js';
export type {
  FsCompleteSubagentRunInput,
  FsStartSubagentRunInput,
  FsSubagentRunFence,
  FsSubagentRunPage,
  FsSubagentToolCallInput,
  FsWorkflowStepRunReconciliation,
} from './subagent-types.js';

const WORKER_INSTANCE_ID = `${process.pid}:${randomUUID()}`;

export class FsSubagentRepository {
  private readonly results: FsSubagentResultRepository;

  constructor(
    private readonly directory: FsSessionDirectory,
    private readonly entities: FsSessionEntityFiles,
  ) {
    this.results = new FsSubagentResultRepository(directory, entities);
  }

  private async runEnvelope(
    sessionId: SessionId | string,
    runId: string,
  ): Promise<FsEntityEnvelope<JsonValue> | null> {
    const normalizedRunId = asAgentRunId(runId);
    return (
      (await this.entities.list<JsonValue>(
        sessionId,
        'subagents',
        'subagent_run',
      )).find(
        (item) =>
          validatedRunData(item).run_id === normalizedRunId,
      ) ?? null
    );
  }

  async listPage(
    sessionId: SessionId | string,
    offset: number,
    limit: number,
  ): Promise<FsSubagentRunPage> {
    const boundedOffset = Math.max(0, Math.trunc(offset));
    const boundedLimit = Math.max(0, Math.trunc(limit));
    const rows = (await this.entities.list<JsonValue>(
      sessionId,
      'subagents',
      'subagent_run',
    ))
      .map((item) => ({
        id: item.id,
        seq: item.seq,
        revision: item.revision,
        ...validatedRunData(item),
      }))
      .sort((left, right) =>
        Date.parse(right.started_at) - Date.parse(left.started_at) ||
        right.seq - left.seq,
      );
    const items = rows.slice(boundedOffset, boundedOffset + boundedLimit);
    const nextOffset = boundedOffset + items.length;
    const timestamps = rows
      .map((row) => Date.parse(row.completed_at ?? row.heartbeat_at))
      .filter(Number.isFinite);
    return {
      items,
      totalCount: rows.length,
      nextOffset: nextOffset < rows.length ? nextOffset : null,
      revision: Math.max(1, ...timestamps),
    };
  }

  private async requireFence(
    fence: FsSubagentRunFence,
  ): Promise<FsEntityEnvelope<JsonValue>> {
    const normalizedFence = validatedFence(fence);
    const current = await this.entities.get<JsonValue>(
      normalizedFence.session_id,
      'subagents',
      normalizedFence.entity_id,
    );
    const data = current ? validatedRunData(current) : undefined;
    if (
      !current ||
      data?.run_id !== normalizedFence.run_id ||
      data.fence_token !== normalizedFence.fence_token ||
      data.status !== 'running'
    ) {
      throw new Error(
        `subagent run '${normalizedFence.run_id}' executor fence was lost`,
      );
    }
    return current;
  }

  async recoverOrphaned(): Promise<number> {
    await this.directory.ensureCatalog();
    const sessions = this.directory.catalog
      .list()
      .filter((entry) => entry.session.kind === 'coder');
    const counts = await Promise.all(
      sessions.map((entry) =>
        this.directory.runMutation(entry.session.id, async () => {
          const persisted = (
            await this.entities.list<JsonValue>(
              entry.session.id,
              'subagents',
              'subagent_run',
            )
          ).map((item) => ({ item, data: validatedRunData(item) }));
          const running = persisted.filter(
            ({ data }) => data.status === 'running',
          );
          if (running.length === 0) return 0;
          const now = new Date().toISOString();
          for (const { item, data } of running) {
            await this.entities.updateWithinMutation<SubagentRunData>(
              entry.session.id,
              'subagents',
              item.id,
              (value) => ({
                ...value,
                status: 'interrupted',
                reason: value.reason ?? 'worker_restart',
                heartbeat_at: now,
                completed_at: now,
              }),
              {
                operation_id: `subagent-run:recover:${item.id}`,
                operation_key: {
                  action: 'recover_subagent_run',
                  run_id: data.run_id,
                  fence_token: data.fence_token,
                },
              },
            );
          }
          return running.length;
        }),
      ),
    );
    return counts.reduce((sum, count) => sum + count, 0);
  }

  async start(
    input: FsStartSubagentRunInput,
  ): Promise<FsSubagentRunFence> {
    const runId = asAgentRunId(input.run_id);
    const normalizedInput: FsStartSubagentRunInput = {
      ...input,
      run_id: runId,
      parent_run_id: optionalAgentRunId(input.parent_run_id),
      parent_agent_run_id: optionalAgentRunId(
        input.parent_agent_run_id,
      ),
    };
    return this.directory.runMutation(input.session_id, async () => {
      const now = new Date().toISOString();
      const persisted = (await this.entities.list<JsonValue>(
        input.session_id,
        'subagents',
        'subagent_run',
      )).map((item) => ({ item, data: validatedRunData(item) }));
      for (const { item, data } of persisted) {
        if (
          data.status === 'running' &&
          data.worker_instance_id !== WORKER_INSTANCE_ID
        ) {
          await this.entities.updateWithinMutation<SubagentRunData>(
            input.session_id,
            'subagents',
            item.id,
            (value) => ({
              ...value,
              status: 'interrupted',
              reason: value.reason ?? 'worker_restart',
              heartbeat_at: now,
              completed_at: now,
            }),
            {
              operation_id: `subagent-run:recover:${item.id}`,
              operation_key: {
                action: 'recover_subagent_run',
                run_id: data.run_id,
              },
            },
          );
        }
      }

      const existing = await this.runEnvelope(
        input.session_id,
        runId,
      );
      if (existing) {
        const data = validatedRunData(existing);
        if (data.status === 'running') {
          return {
            session_id: input.session_id,
            run_id: runId,
            entity_id: validatedUuid(
              existing.id,
              'subagent fence entity_id',
            ),
            fence_token: data.fence_token,
          };
        }
        throw new Error(`subagent run '${runId}' is already terminal`);
      }

      const fenceToken = randomUUID();
      const created = await this.entities.createWithinMutation(
        input.session_id,
        'subagents',
        {
          kind: 'subagent_run',
          data: {
            session_id: input.session_id,
            run_id: runId,
            parent_run_id: normalizedInput.parent_run_id ?? null,
            parent_agent_run_id:
              normalizedInput.parent_agent_run_id ?? null,
            spawn_id: input.spawn_id ?? null,
            profile: input.profile,
            label: input.label ?? null,
            task_preview: input.task_preview?.slice(0, 1_000) ?? null,
            requested_provider: input.requested_provider ?? null,
            requested_model: input.requested_model ?? null,
            requested_reasoning_effort:
              input.requested_reasoning_effort ?? null,
            wait_mode: input.wait_mode ?? 'foreground',
            effective_provider: input.effective_provider ?? null,
            effective_model: input.effective_model ?? null,
            effective_reasoning_effort:
              input.effective_reasoning_effort ?? null,
            effective_capabilities: input.effective_capabilities ?? [],
            environment_fingerprint:
              input.environment_fingerprint ?? null,
            policy_mode: input.policy_mode ?? null,
            max_turns: input.max_turns,
            max_tool_calls: input.max_tool_calls ?? null,
            timeout_ms: input.timeout_ms ?? null,
            stall_ms: input.stall_ms ?? null,
            research_depth: input.research_depth ?? null,
            soft_tool_target: input.soft_tool_target ?? null,
            soft_time_target_ms: input.soft_time_target_ms ?? null,
            status: 'running',
            reason: null,
            turns: 0,
            auto_continues: 0,
            tool_calls: 0,
            logical_operations: 0,
            productive_operations: 0,
            paginate_calls: 0,
            duplicate_calls: 0,
            error_calls: 0,
            refused_calls: 0,
            elapsed_ms: null,
            input_tokens: null,
            output_tokens: null,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: null,
            has_summary: false,
            output_id: null,
            synthesis_nudged: false,
            started_at: now,
            heartbeat_at: now,
            completed_at: null,
            worker_instance_id: WORKER_INSTANCE_ID,
            fence_token: fenceToken,
          } satisfies SubagentRunData,
          operation_id: `subagent-run:${runId}:start`,
          operation_key: {
            action: 'start_subagent_run',
            input: normalizedInput,
            fence_token: fenceToken,
          },
        },
      );
      return {
        session_id: input.session_id,
        run_id: runId,
        entity_id: validatedUuid(
          created.id,
          'subagent fence entity_id',
        ),
        fence_token: fenceToken,
      };
    });
  }

  async assertFence(fence: FsSubagentRunFence): Promise<void> {
    await this.requireFence(fence);
  }

  async heartbeat(
    runId: string,
    fence: FsSubagentRunFence,
  ): Promise<void> {
    const normalizedRunId = asAgentRunId(runId);
    const normalizedFence = validatedFence(fence);
    if (normalizedRunId !== normalizedFence.run_id) {
      throw new Error('subagent heartbeat run/fence mismatch');
    }
    await this.directory.runMutation(normalizedFence.session_id, async () => {
      const current = await this.requireFence(normalizedFence);
      const heartbeatAt = new Date().toISOString();
      await this.entities.updateWithinMutation<SubagentRunData>(
        normalizedFence.session_id,
        'subagents',
        current.id,
        (value) => ({ ...value, heartbeat_at: heartbeatAt }),
        {
          operation_id:
            `subagent-run:${normalizedRunId}:heartbeat:${randomUUID()}`,
          operation_key: {
            action: 'heartbeat_subagent_run',
            run_id: normalizedRunId,
            fence_token: normalizedFence.fence_token,
            heartbeat_at: heartbeatAt,
          },
        },
      );
    });
  }

  async recordToolCall(
    input: FsSubagentToolCallInput,
  ): Promise<void> {
    const runId = asAgentRunId(input.run_id);
    const fence = input.fence ? validatedFence(input.fence) : undefined;
    if (
      fence &&
      (fence.run_id !== runId ||
        String(fence.session_id) !== String(input.session_id))
    ) {
      throw new Error('subagent tool call run/fence mismatch');
    }
    if (fence) await this.requireFence(fence);
    const now = new Date().toISOString();
    await this.entities.create(input.session_id, 'subagents', {
      kind: 'subagent_tool_call',
      data: {
        session_id: input.session_id,
        run_id: runId,
        seq: input.seq,
        turn: input.turn ?? null,
        tool_name: input.tool_name,
        logical_operation_id: input.logical_operation_id ?? null,
        productive: input.productive ?? false,
        is_error: input.is_error,
        refusal_kind: input.refusal_kind ?? null,
        duration_ms: input.duration_ms,
        result_chars: input.result_chars,
        created_at: now,
      } satisfies SubagentToolCallData,
      operation_id: `subagent-tool:${runId}:${input.seq}`,
      operation_key: {
        action: 'record_subagent_tool_call',
        run_id: runId,
        seq: input.seq,
      },
    });
    if (fence) {
      await this.heartbeat(runId, fence);
    }
  }

  async complete(input: FsCompleteSubagentRunInput): Promise<void> {
    const runId = asAgentRunId(input.run_id);
    const fence = validatedFence(input.fence);
    if (runId !== fence.run_id) {
      throw new Error('subagent terminal run/fence mismatch');
    }
    await this.directory.runMutation(fence.session_id, async () => {
      const current = await this.requireFence(fence);
      if (current.id !== fence.entity_id) {
        throw new Error('subagent terminal run/fence mismatch');
      }
      const now = new Date().toISOString();
      await this.entities.updateWithinMutation<SubagentRunData>(
        fence.session_id,
        'subagents',
        current.id,
        (value) => ({
          ...value,
          reason: input.reason,
          turns: input.turns,
          auto_continues: input.auto_continues,
          tool_calls: input.tool_calls,
          logical_operations: input.logical_operations,
          productive_operations: input.productive_operations,
          paginate_calls: input.paginate_calls,
          duplicate_calls: input.duplicate_calls,
          error_calls: input.error_calls,
          refused_calls: input.refused_calls,
          elapsed_ms: input.elapsed_ms,
          input_tokens: input.input_tokens,
          output_tokens: input.output_tokens,
          cache_read_input_tokens:
            input.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens:
            input.cache_creation_input_tokens ?? 0,
          has_summary: input.has_summary,
          output_id: input.output_id ?? null,
          synthesis_nudged: input.synthesis_nudged ?? false,
          status: 'completed',
          heartbeat_at: now,
          completed_at: now,
        }),
        {
          operation_id:
            `subagent-run:${runId}:complete`,
          operation_key: {
            action: 'complete_subagent_run',
            run_id: runId,
            reason: input.reason,
            fence_token: fence.fence_token,
          },
        },
      );
    });
  }

  async reconcileWorkflowStepRun(
    sessionId: SessionId | string,
    groupId: string,
    stepId: string,
  ): Promise<FsWorkflowStepRunReconciliation> {
    return this.results.reconcileWorkflowStepRun(
      sessionId,
      groupId,
      stepId,
    );
  }

  async writeTranscript(
    sessionId: SessionId | string,
    spawnId: string,
    agentIndex: number,
    messages: AgentMessage[],
  ): Promise<string | null> {
    return this.results.writeTranscript(
      sessionId,
      spawnId,
      agentIndex,
      messages,
    );
  }

  async findTranscript(
    sessionId: SessionId | string,
    spawnId: string,
    agentIndex: number,
  ): Promise<string | null> {
    return this.results.findTranscript(
      sessionId,
      spawnId,
      agentIndex,
    );
  }
}
