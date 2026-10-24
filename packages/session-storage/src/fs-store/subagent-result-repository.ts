import { join } from 'node:path';
import type { AgentMessage } from '@mcp/provider-sdk';
import {
  asSessionId,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import { FsSessionEntityFiles } from './entity-files.js';
import { FsSessionDirectory } from './session-directory.js';
import type {
  FsWorkflowStepRunReconciliation,
  SubagentTranscriptData,
} from './subagent-types.js';
import {
  validatedRunData,
  workflowStepStatus,
} from './subagent-validation.js';

export class FsSubagentResultRepository {
  constructor(
    private readonly directory: FsSessionDirectory,
    private readonly entities: FsSessionEntityFiles,
  ) {}

  async reconcileWorkflowStepRun(
    sessionId: SessionId | string,
    groupId: string,
    stepId: string,
  ): Promise<FsWorkflowStepRunReconciliation> {
    const matches = (
      await this.entities.list<JsonValue>(
        sessionId,
        'subagents',
        'subagent_run',
      )
    )
      .map(validatedRunData)
      .filter(
        (data) =>
          data.spawn_id === groupId && data.label === stepId,
      );
    if (matches.length !== 1) {
      return {
        outcome: 'outcome_unknown',
        detail:
          matches.length === 0
            ? `no child lifecycle file matches group '${groupId}' step '${stepId}'`
            : `multiple child lifecycle files match group '${groupId}' step '${stepId}'`,
      };
    }
    const data = matches[0];
    if (
      data.completed_at == null ||
      data.status === 'running' ||
      data.status === 'interrupted' ||
      /outcome[_ ]unknown/i.test(data.reason ?? '') ||
      !data.reason
    ) {
      return {
        outcome: 'outcome_unknown',
        runId: data.run_id,
        detail:
          `child '${data.run_id}' has no durable terminal acknowledgement`,
      };
    }
    return {
      outcome: 'terminal',
      runId: data.run_id,
      stepStatus: workflowStepStatus(data.reason),
      reason: data.reason,
      resultRef: data.output_id ?? undefined,
      hasSummary: data.has_summary,
      detail:
        `reconciled terminal filesystem child ${data.status}/${data.reason}`,
    };
  }

  async writeTranscript(
    sessionId: SessionId | string,
    spawnId: string,
    agentIndex: number,
    messages: AgentMessage[],
  ): Promise<string | null> {
    if (messages.length === 0) return null;
    const envelope = await this.entities.create(
      sessionId,
      'subagents',
      {
        kind: 'subagent_transcript',
        data: {
          session_id: asSessionId(String(sessionId)),
          spawn_id: spawnId,
          agent_index: agentIndex,
          messages,
        } satisfies SubagentTranscriptData,
        operation_id:
          `subagent-transcript:${spawnId}:${agentIndex}`,
        operation_key: {
          action: 'write_subagent_transcript',
          spawn_id: spawnId,
          agent_index: agentIndex,
          messages,
        },
      },
    );
    const entry = await this.directory.requireEntry(sessionId);
    return join(
      entry.location.bundle_path,
      'subagents',
      `${envelope.id}.json`,
    );
  }

  async findTranscript(
    sessionId: SessionId | string,
    spawnId: string,
    agentIndex: number,
  ): Promise<string | null> {
    const envelope = (await this.entities.list<JsonValue>(
      sessionId,
      'subagents',
      'subagent_transcript',
    )).find((item) => {
      const data = item.data as unknown as SubagentTranscriptData;
      return (
        data.spawn_id === spawnId &&
        data.agent_index === agentIndex
      );
    });
    if (!envelope) return null;
    const entry = await this.directory.requireEntry(sessionId);
    return join(
      entry.location.bundle_path,
      'subagents',
      `${envelope.id}.json`,
    );
  }
}
