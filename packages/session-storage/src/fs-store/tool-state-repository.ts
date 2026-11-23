import {
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { sessionJournalPath } from '../session-journal-path.js';
import {
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import {
  parseCoderTurnPayload,
  projectConversation,
  toJsonValue,
} from './conversation-codec.js';
import { reverseCommittedConversationCommits } from './conversation-reader.js';
import { FsSessionEntityFiles } from './entity-files.js';
import { FsSessionDirectory } from './session-directory.js';
import type {
  FsSessionEvent,
  FsToolCallStats,
  FsToolCallSummaryPage,
} from './operational-types.js';
import type { FsToolCallRecord } from './types.js';
import { MemoryCallProjection } from './memory-call-projection.js';

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    : [];
}

function numberMetadata(
  call: FsToolCallRecord,
  key: string,
  fallback = 0,
): number {
  const value = call.metadata[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : fallback;
}

function stringMetadata(
  call: FsToolCallRecord,
  key: string,
): string | null {
  const value = call.metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function outcome(
  call: FsToolCallRecord,
): FsToolCallStats['recent'][number]['outcome'] {
  const refusal = stringMetadata(call, 'refusal_kind');
  const guardAction = stringMetadata(call, 'guard_action');
  if (
    call.is_error &&
    !call.nested &&
    stringMetadata(call, 'guard_origin_tool_use_id')
  ) {
    return 'propagated_parent_failure';
  }
  if (call.is_error && refusal) return 'root_refusal';
  if (call.is_error) return 'genuine_error';
  if (guardAction === 'reuse') return 'reuse';
  if (
    guardAction === 'shadow' ||
    call.metadata.would_block === true
  ) {
    return 'shadow';
  }
  return 'success';
}

function emptyStats(): FsToolCallStats {
  return {
    totalCalls: 0,
    directCalls: 0,
    nestedCalls: 0,
    guardOutcomes: {
      genuineErrors: 0,
      rootRefusals: 0,
      propagatedParentFailures: 0,
      reusedCalls: 0,
      shadowCandidates: 0,
    },
    byName: [],
    recent: [],
    savings: {
      totalRawChars: 0,
      totalShapedChars: 0,
      totalSavedChars: 0,
      totalSavedTokensEst: 0,
      byTool: [],
      semanticSavedChars: 0,
      jsonCrushSavedChars: 0,
      hardCapSavedChars: 0,
      nestedRawChars: 0,
      byTechnique: [],
    },
  };
}

export class FsToolStateRepository {
  private readonly memoryCalls = new MemoryCallProjection();
  constructor(
    private readonly directory: FsSessionDirectory,
    private readonly entities: FsSessionEntityFiles,
  ) {}

  async getDisabled(id: SessionId | string): Promise<Set<string>> {
    const entry = await this.directory.requireEntry(id);
    const state =
      entry.state ??
      this.directory.repository.readStateSync(entry.location);
    return new Set(strings(state.tools.disabled));
  }

  setDisabled(
    id: SessionId | string,
    toolName: string,
    disabled: boolean,
  ): Promise<void> {
    return this.bulkSetDisabled(id, [toolName], disabled);
  }

  bulkSetDisabled(
    id: SessionId | string,
    toolNames: readonly string[],
    disabled: boolean,
  ): Promise<void> {
    return this.directory.runMutation(id, async () => {
      const entry = await this.directory.requireEntry(id);
      await this.directory.repository.updateState(entry.location, (state) => {
        const current = new Set(strings(state.tools.disabled));
        for (const toolName of toolNames) {
          if (disabled) current.add(toolName);
          else current.delete(toolName);
        }
        return {
          ...state,
          tools: { ...state.tools, disabled: [...current].sort() },
        };
      });
    });
  }

  async copyDisabled(
    fromId: SessionId | string,
    toId: SessionId | string,
  ): Promise<number> {
    const tools = [...(await this.getDisabled(fromId))];
    return this.directory.runMutation(toId, async () => {
      const entry = await this.directory.requireEntry(toId);
      await this.directory.repository.updateState(entry.location, (state) => ({
        ...state,
        tools: { ...state.tools, disabled: [...tools].sort() },
      }));
      return tools.length;
    });
  }

  setActiveSkills(
    id: SessionId | string,
    skillIds: readonly string[],
  ): Promise<void> {
    return this.directory.runMutation(id, async () => {
      const entry = await this.directory.requireEntry(id);
      await this.directory.repository.updateState(entry.location, (state) => ({
        ...state,
        tools: {
          ...state.tools,
          active_skills: [...new Set(skillIds)].sort(),
        },
      }));
    });
  }

  async appendEvent(
    id: SessionId | string,
    type: string,
    payload: unknown,
    operationId?: string,
  ): Promise<FsSessionEvent> {
    const event = await this.entities.create(id, 'events', {
      kind: 'session_event',
      data: { type, payload: toJsonValue(payload) },
      operation_id: operationId,
    });
    const data = event.data as {
      type: string;
      payload: JsonValue;
    };
    return {
      id: event.id,
      seq: event.seq,
      operation_id: event.operation_id,
      type: data.type,
      created_at: event.created_at,
      payload: data.payload,
    };
  }

  async listEvents(
    id: SessionId | string,
    type?: string,
  ): Promise<FsSessionEvent[]> {
    const events = await this.entities.list<{
      type: string;
      payload: JsonValue;
    }>(id, 'events', 'session_event');
    return events
      .map((event) => ({
        id: event.id,
        seq: event.seq,
        operation_id: event.operation_id,
        type: event.data.type,
        created_at: event.created_at,
        payload: event.data.payload,
      }))
      .filter((event) => type == null || event.type === type);
  }

  async getEventByOperationId(
    id: SessionId | string,
    operationId: string,
    type?: string,
  ): Promise<FsSessionEvent | null> {
    const events = await this.entities.list<{
      type: string;
      payload: JsonValue;
    }>(id, 'events', 'session_event');
    const event = events.find((candidate) =>
      candidate.operation_id === operationId
      && (type == null || candidate.data.type === type),
    );
    if (!event) return null;
    return {
      id: event.id,
      seq: event.seq,
      operation_id: event.operation_id,
      type: event.data.type,
      created_at: event.created_at,
      payload: event.data.payload,
    };
  }

  async listCalls(
    id: SessionId | string,
  ): Promise<FsToolCallRecord[]> {
    const entry = await this.directory.requireEntry(id);
    return projectConversation(
      this.directory.repository.readConversationSync(entry.location),
    ).toolCalls;
  }

  /** Small async projection for memory KPIs; never hydrates the full transcript. */
  async listMemoryCalls(id: SessionId | string): Promise<Array<{ tool_name: string; created_at: string }>> {
    const entry = await this.directory.requireEntry(id);
    return (await this.memoryCalls.read(sessionJournalPath(entry.location.bundle_path))).calls;
  }

  /**
   * Metadata-only, streaming projection for the Workbench. Unlike stats(), it
   * never materializes the complete conversation or hydrates tool artifacts.
   * Reverse traversal applies later rollback markers to older tool calls.
   */
  async listSummaryPage(
    id: SessionId | string,
    offset: number,
    limit: number,
  ): Promise<FsToolCallSummaryPage> {
    const entry = await this.directory.requireEntry(id);
    const conversationPath = sessionJournalPath(entry.location.bundle_path);
    const byName = new Map<string, FsToolCallStats['byName'][number]>();
    let visibleBeforeSeq = Number.POSITIVE_INFINITY;
    let newestCommitAt: string | null = null;

    for await (const commit of reverseCommittedConversationCommits(conversationPath, 'metadata')) {
      newestCommitAt ??= commit.committed_at;
      const payload = parseCoderTurnPayload(commit);
      for (const call of payload.tool_calls) {
        if (call.message_seq >= visibleBeforeSeq) continue;
        const kind = outcome(call);
        const current = byName.get(call.tool_name) ?? {
          name: call.tool_name,
          count: 0,
          errorCount: 0,
          refusedCount: 0,
          propagatedFailureCount: 0,
          reuseCount: 0,
          shadowCount: 0,
          lastAt: null,
        };
        current.count += 1;
        current.lastAt ??= call.output.created_at;
        if (kind === 'genuine_error') current.errorCount += 1;
        if (kind === 'root_refusal') current.refusedCount += 1;
        if (kind === 'propagated_parent_failure') current.propagatedFailureCount += 1;
        if (kind === 'reuse') current.reuseCount += 1;
        if (kind === 'shadow') current.shadowCount += 1;
        byName.set(call.tool_name, current);
      }
      if (payload.truncate_from_seq !== undefined) {
        visibleBeforeSeq = Math.min(visibleBeforeSeq, payload.truncate_from_seq);
      }
    }

    const rows = [...byName.values()].sort(
      (left, right) => right.count - left.count || left.name.localeCompare(right.name),
    );
    const boundedOffset = Math.max(0, Math.trunc(offset));
    const boundedLimit = Math.max(0, Math.trunc(limit));
    const items = rows.slice(boundedOffset, boundedOffset + boundedLimit);
    const nextOffset = boundedOffset + items.length;
    let fileRevision = 1;
    try {
      fileRevision = Math.max(1, Math.trunc((await stat(conversationPath)).mtimeMs));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const commitRevision = Date.parse(newestCommitAt ?? '');
    return {
      items,
      totalCount: rows.length,
      nextOffset: nextOffset < rows.length ? nextOffset : null,
      revision: Math.max(
        fileRevision,
        Number.isFinite(commitRevision) ? commitRevision : 1,
      ),
    };
  }

  async stats(
    id: SessionId | string,
    recentLimit = 30,
  ): Promise<FsToolCallStats> {
    const calls = await this.listCalls(id);
    if (calls.length === 0) return emptyStats();
    const stats = emptyStats();
    stats.totalCalls = calls.length;
    stats.directCalls = calls.filter((call) => !call.nested).length;
    stats.nestedCalls = calls.length - stats.directCalls;
    const byName = new Map<
      string,
      FsToolCallStats['byName'][number]
    >();
    const savings = new Map<
      string,
      { name: string; rawChars: number; shapedChars: number }
    >();
    const techniques = new Map<
      string,
      FsToolCallStats['savings']['byTechnique'][number]
    >();

    for (const call of calls) {
      const kind = outcome(call);
      const row = byName.get(call.tool_name) ?? {
        name: call.tool_name,
        count: 0,
        errorCount: 0,
        refusedCount: 0,
        propagatedFailureCount: 0,
        reuseCount: 0,
        shadowCount: 0,
        lastAt: null,
      };
      row.count += 1;
      row.lastAt = call.output.created_at;
      if (kind === 'genuine_error') row.errorCount += 1;
      if (kind === 'root_refusal') row.refusedCount += 1;
      if (kind === 'propagated_parent_failure') {
        row.propagatedFailureCount += 1;
      }
      if (kind === 'reuse') row.reuseCount += 1;
      if (kind === 'shadow') row.shadowCount += 1;
      byName.set(call.tool_name, row);

      if (call.nested) {
        stats.savings.nestedRawChars += numberMetadata(
          call,
          'output_chars',
          call.output.raw?.size ?? 0,
        );
        continue;
      }
      const rawChars = numberMetadata(
        call,
        'output_chars',
        call.output.raw?.size ?? call.output.shaped?.size ?? 0,
      );
      const shapedChars = numberMetadata(
        call,
        'output_chars_shaped',
        call.output.shaped?.size ?? rawChars,
      );
      const saved = savings.get(call.tool_name) ?? {
        name: call.tool_name,
        rawChars: 0,
        shapedChars: 0,
      };
      saved.rawChars += rawChars;
      saved.shapedChars += shapedChars;
      savings.set(call.tool_name, saved);
      const reductionKind =
        stringMetadata(call, 'reduction_kind') ??
        (call.metadata.truncated === true ? 'hard_cap' : 'none');
      const technique =
        stringMetadata(call, 'reduction_technique') ??
        (call.metadata.truncated === true
          ? 'legacy-structured-truncated-flag'
          : 'none');
      const key = `${reductionKind}\0${technique}`;
      const aggregate = techniques.get(key) ?? {
        kind: reductionKind,
        technique,
        calls: 0,
        rawChars: 0,
        shapedChars: 0,
        savedChars: 0,
      };
      aggregate.calls += 1;
      aggregate.rawChars += rawChars;
      aggregate.shapedChars += shapedChars;
      aggregate.savedChars = Math.max(
        0,
        aggregate.rawChars - aggregate.shapedChars,
      );
      techniques.set(key, aggregate);
    }

    stats.byName = [...byName.values()].sort(
      (left, right) =>
        right.count - left.count || left.name.localeCompare(right.name),
    );
    for (const row of stats.byName) {
      stats.guardOutcomes.genuineErrors += row.errorCount;
      stats.guardOutcomes.rootRefusals += row.refusedCount;
      stats.guardOutcomes.propagatedParentFailures +=
        row.propagatedFailureCount;
      stats.guardOutcomes.reusedCalls += row.reuseCount;
      stats.guardOutcomes.shadowCandidates += row.shadowCount;
    }
    const limit = Math.max(1, Math.min(200, Math.floor(recentLimit)));
    stats.recent = calls
      .filter((call) => !call.nested)
      .slice(-limit)
      .reverse()
      .map((call) => ({
        id: call.id,
        seq: call.message_seq,
        name: call.tool_name,
        argsPreview: JSON.stringify(call.args).slice(0, 200),
        isError: call.is_error,
        durationMs: call.duration_ms,
        createdAt: call.output.created_at,
        outcome: outcome(call),
        guardAction: stringMetadata(call, 'guard_action'),
        guardReason: stringMetadata(call, 'guard_reason'),
      }));
    stats.savings.byTool = [...savings.values()]
      .map((item) => ({
        ...item,
        savedChars: Math.max(0, item.rawChars - item.shapedChars),
      }))
      .filter((item) => item.savedChars > 0)
      .sort((left, right) => right.savedChars - left.savedChars)
      .slice(0, 20);
    stats.savings.totalRawChars = [...savings.values()].reduce(
      (sum, item) => sum + item.rawChars,
      0,
    );
    stats.savings.totalShapedChars = [...savings.values()].reduce(
      (sum, item) => sum + item.shapedChars,
      0,
    );
    stats.savings.totalSavedChars = Math.max(
      0,
      stats.savings.totalRawChars - stats.savings.totalShapedChars,
    );
    stats.savings.totalSavedTokensEst = Math.round(
      stats.savings.totalSavedChars / 4,
    );
    stats.savings.byTechnique = [...techniques.values()].sort(
      (left, right) => right.savedChars - left.savedChars,
    );
    const savedFor = (kind: string) =>
      stats.savings.byTechnique
        .filter((item) => item.kind === kind)
        .reduce((sum, item) => sum + item.savedChars, 0);
    stats.savings.semanticSavedChars = savedFor('semantic');
    stats.savings.jsonCrushSavedChars = savedFor('json_crush');
    stats.savings.hardCapSavedChars = savedFor('hard_cap');
    return stats;
  }
}
