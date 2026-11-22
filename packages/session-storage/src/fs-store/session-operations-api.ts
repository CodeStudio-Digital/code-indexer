import type { AgentMessage } from '@mcp/provider-sdk';
import { promptInputTokens } from '@mcp/provider-sdk/prompt-cache-metrics.js';
import type { CoderSessionStats } from '@mcp/session-storage/session-state-types.js';
import {
  SessionOperationConflictError,
  type JsonValue,
  type SessionId,
  type SessionState,
} from '@mcp/session-storage';
import {
  hydrateMessage,
  projectConversation,
  toJsonValue,
} from './conversation-codec.js';
import { FsConversationChapterRepository } from './conversation-chapter-repository.js';
import { FsConversationWriter } from './conversation-writer.js';
import { FsSessionDirectory } from './session-directory.js';
import { FsSessionEntityFiles } from './entity-files.js';
import { FsSessionRollbackRepository } from './session-rollback-api.js';
import { FsToolOutputReader } from './tool-output-reader.js';
import { ConversationStatsReader, type ReadConversationStats } from './conversation-stats.js';
import type {
  FsAppendMessageUsage,
  FsCoderSession,
  FsStoredMessage,
  FsToolCallInput,
  FsToolCallRecord,
} from './types.js';

type CopyMode =
  | { kind: 'duplicate'; targetId?: SessionId; title?: string }
  | { kind: 'fork'; beforeSeq: number };

function record(value: JsonValue): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function usage(message: FsStoredMessage): FsAppendMessageUsage {
  return {
    input_tokens: message.usage.input_tokens,
    output_tokens: message.usage.output_tokens,
    cache_read_input_tokens: message.usage.cache_read_tokens,
    cache_creation_input_tokens: message.usage.cache_creation_tokens,
  };
}

function textFromMessage(message: AgentMessage): string {
  return message.content
    .filter(
      (block): block is Extract<AgentMessage['content'][number], { type: 'text' }> =>
        block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n');
}

function runtimeForCopy(state: SessionState): JsonValue {
  const runtime =
    state.extra.runtime != null &&
    typeof state.extra.runtime === 'object' &&
    !Array.isArray(state.extra.runtime)
      ? state.extra.runtime
      : {};
  return toJsonValue({
    ...runtime,
    last_response_id: null,
    last_response_message_count: null,
    cloudcode_session_id: null,
    pending_agent_transition: null,
    config_lock: null,
  });
}

export class FsSessionOperations {
  readonly #writer: FsConversationWriter;
  readonly #outputs: FsToolOutputReader;
  readonly #chapters: FsConversationChapterRepository;

  constructor(
    private readonly directory: FsSessionDirectory,
    private readonly readStats: ReadConversationStats = new ConversationStatsReader().read,
  ) {
    this.#writer = new FsConversationWriter(directory);
    this.#outputs = new FsToolOutputReader(directory);
    this.#chapters = new FsConversationChapterRepository(
      directory,
      new FsSessionEntityFiles(directory),
    );
  }

  async getSessionStats(
    id: SessionId | string,
  ): Promise<CoderSessionStats | null> {
    const entry = await this.directory.entry(id);
    if (!entry) return null;
    this.directory.repository.assertLocationMatchesResolver(entry.location);
    const { latest, ...counts } = await this.readStats(entry.location);
    const session = this.directory.map(entry);
    return {
      ...counts,
      total_input_tokens: session.total_input_tokens,
      total_output_tokens: session.total_output_tokens,
      total_cache_read_tokens: session.total_cache_read_tokens,
      total_cache_creation_tokens: session.total_cache_creation_tokens,
      last_turn_input_tokens: session.last_turn_input_tokens,
      last_turn_context: latest?.context ?? null,
      last_turn_prompt_tokens: latest?.context?.prompt_tokens ?? (latest ? promptInputTokens({
        provider: session.provider, inputTokens: latest.input_tokens,
        cacheReadTokens: latest.cache_read_tokens, cacheCreationTokens: latest.cache_creation_tokens,
      }) : null),
      duration_ms: Math.max(
        0,
        Date.parse(session.updated_at) - Date.parse(session.created_at),
      ),
    };
  }

  duplicateSession(
    id: SessionId | string,
    options: { targetId?: SessionId; title?: string } = {},
  ): Promise<FsCoderSession> {
    return this.#copy(id, { kind: 'duplicate', ...options }).then((result) => result.session);
  }

  forkSessionBeforeSeq(
    id: SessionId | string,
    beforeSeq: number,
  ): Promise<{ session: FsCoderSession; seed_text: string }> {
    return this.#copy(id, { kind: 'fork', beforeSeq });
  }

  async #copy(
    id: SessionId | string,
    mode: CopyMode,
  ): Promise<{ session: FsCoderSession; seed_text: string }> {
    return this.directory.runMutation(id, async () => {
      const entry = await this.directory.requireEntry(id);
      const source = this.directory.map(entry);
      const sourceCommits =
        this.directory.repository.readConversationSync(entry.location);
      const projection = projectConversation(sourceCommits);
      const targetMessage =
        mode.kind === 'fork'
          ? projection.storedMessages.find(
              (message) => message.seq === mode.beforeSeq,
            )
          : undefined;
      if (mode.kind === 'fork' && !targetMessage) {
        throw new Error(`message seq ${mode.beforeSeq} not in session`);
      }
      if (targetMessage && targetMessage.role !== 'user') {
        throw new Error(
          `message seq ${targetMessage.seq} is not a user message`,
        );
      }
      const sourceMessages =
        mode.kind === 'duplicate'
          ? projection.storedMessages
          : projection.storedMessages.filter(
              (message) => message.seq < mode.beforeSeq,
            );
      const existingTarget = mode.kind === 'duplicate' && mode.targetId
        ? await this.directory.getSession(mode.targetId)
        : null;
      if (existingTarget && existingTarget.id === source.id) {
        throw new Error('duplicate target must differ from its source session');
      }
      if (
        existingTarget
        && existingTarget.metadata.workbench_copy_source_session_id !== source.id
      ) {
        throw new Error(`duplicate target ${existingTarget.id} belongs to another command`);
      }
      const created = existingTarget
        ?? await this.#createTarget(source, entry.session.metadata, mode);
      const targetEntry = await this.directory.requireEntry(created.id);
      const targetCommits =
        this.directory.repository.readConversationSync(targetEntry.location);
      const targetProjection = projectConversation(targetCommits);
      if (targetCommits.length > 0 && (projection.toolOutcomes.pending.length || projection.toolOutcomes.resolved.length)
        && JSON.stringify(targetProjection.toolOutcomes) !== JSON.stringify(projection.toolOutcomes)) {
        // A legacy replay changes tool-call identities and may omit rolled-back
        // operations. It cannot safely manufacture their resolution provenance.
        throw new SessionOperationConflictError('An incomplete legacy copy cannot discard tool outcome evidence; create a fresh copy');
      }
      const targetAlreadyComplete =
        targetProjection.storedMessages.length === sourceMessages.length &&
        targetProjection.storedMessages.every((message, index) => {
          const expected = sourceMessages[index];
          return expected != null &&
            message.seq === expected.seq &&
            message.role === expected.role &&
            JSON.stringify(message.content) === JSON.stringify(expected.content);
        });
      if (targetCommits.length === 0) {
        // The canonical commits already contain the exact projected messages,
        // tool calls and append-only rollback history. Clone them once instead
        // of rebuilding the target with one fsync and one full projection scan
        // per message. A fork is the same snapshot plus one rollback marker.
        await this.directory.repository.cloneConversationProjection(
          entry.location,
          targetEntry.location,
          sourceCommits,
        );
        await this.#copyState(entry.state, created.id, mode);
        if (mode.kind === 'fork') {
          await new FsSessionRollbackRepository(this.directory)
            .rollbackSessionToSeq(created.id, mode.beforeSeq);
        }
      } else if (!targetAlreadyComplete) {
        // Deterministic workbench copies may retry a target created by an older
        // build or interrupted during the legacy replay. Preserve that recovery
        // path without penalizing every new duplicate/fork.
        await this.#replay(
          entry.location,
          created.id,
          sourceMessages,
          projection.toolCalls,
        );
        await this.#copyChapters(source.id, created.id, mode);
        await this.#copyState(entry.state, created.id, mode);
      } else {
        // Idempotent retry of an already-published snapshot. State is cheap to
        // reapply and may be the phase that failed in the previous request.
        await this.#copyState(entry.state, created.id, mode);
      }
      return {
        session: (await this.directory.getSession(created.id)) ?? created,
        seed_text: targetMessage
          ? textFromMessage(hydrateMessage(entry.location, targetMessage))
          : '',
      };
    });
  }

  async #createTarget(
    source: FsCoderSession,
    metadata: Readonly<Record<string, JsonValue>>,
    mode: CopyMode,
  ): Promise<FsCoderSession> {
    const suffix = mode.kind === 'fork' ? ' (fork)' : ' (cópia)';
    const title = mode.kind === 'duplicate' && mode.title
      ? mode.title
      : `${source.title}${suffix}`;
    const metadataWithCopySource = mode.kind === 'duplicate' && mode.targetId
      ? {
          ...metadata,
          workbench_copy_source_session_id: source.id,
        }
      : metadata;
    if (source.is_global) {
      return this.directory.createGlobalSession({
        ...(mode.kind === 'duplicate' && mode.targetId ? { id: mode.targetId } : {}),
        parent_session_id: source.id,
        title,
        provider: source.provider,
        model: source.model,
        agent: source.agent,
        owner_project_id: source.project_id,
        realProjects: source.linked_projects.map((project) => ({
          projectId: project.project_id,
          rootPath: project.root_path,
          isPrimary: project.is_primary,
          label: project.label,
        })),
        metadata: metadataWithCopySource,
      });
    }
    if (source.project_id == null) {
      throw new Error(`Session ${source.id} has no owning project`);
    }
    return this.directory.createSession({
      ...(mode.kind === 'duplicate' && mode.targetId ? { id: mode.targetId } : {}),
      parent_session_id: source.id,
      project_id: source.project_id,
      title,
      provider: source.provider,
      model: source.model,
      agent: source.agent,
      metadata: metadataWithCopySource,
    });
  }

  async #replay(
    sourceLocation: Awaited<ReturnType<FsSessionDirectory['requireEntry']>>['location'],
    targetId: SessionId,
    messages: readonly FsStoredMessage[],
    calls: readonly FsToolCallRecord[],
  ): Promise<void> {
    const generatedToolResultIds = new Set<string>();
    const callsByMessageSeq = new Map<number, FsToolCallRecord[]>();
    for (const call of calls) {
      const bucket = callsByMessageSeq.get(call.message_seq);
      if (bucket) bucket.push(call);
      else callsByMessageSeq.set(call.message_seq, [call]);
    }
    for (const stored of messages) {
      const hydrated = hydrateMessage(sourceLocation, stored);
      if (
        stored.role === 'tool' &&
        hydrated.content.every(
          (block) =>
            block.type === 'tool_result' &&
            generatedToolResultIds.has(block.tool_use_id),
        )
      ) {
        continue;
      }
      if (stored.role !== 'assistant') {
        await this.#writer.appendMessage({
          session_id: targetId,
          message: hydrated,
          usage: usage(stored),
          operation_id: `copy:${targetId}:message:${stored.seq}`,
        });
        continue;
      }
      const attached = callsByMessageSeq.get(stored.seq) ?? [];
      const converted = await Promise.all(
        attached.map((call) => this.#toolInput(sourceLocation.session_id, call)),
      );
      for (const call of attached) {
        if (!call.nested) generatedToolResultIds.add(call.tool_use_id);
      }
      await this.#writer.persistAssistantTurn({
        session_id: targetId,
        message: hydrated,
        usage: usage(stored),
        context: stored.usage.context,
        tool_calls: converted.filter((_, index) => !attached[index].nested),
        nested_tool_calls: converted.filter((_, index) => attached[index].nested),
        operation_id: `copy:${targetId}:assistant:${stored.seq}`,
      });
    }
  }

  async #toolInput(
    sourceId: SessionId,
    call: FsToolCallRecord,
  ): Promise<FsToolCallInput> {
    const output = await this.#outputs.get(sourceId, call.tool_use_id);
    const raw = output?.raw ?? null;
    const shaped = output?.shaped ?? null;
    const selected = shaped ?? raw ?? new Uint8Array();
    const metadata = call.metadata as Record<string, unknown>;
    return {
      ...metadata,
      tool_use_id: call.tool_use_id,
      tool_name: call.tool_name,
      args: record(call.args),
      result_text: Buffer.from(selected).toString('utf8'),
      ...(raw ? { raw_result: raw } : {}),
      ...(shaped ? { shaped_result: shaped } : {}),
      is_error: call.is_error,
      duration_ms: call.duration_ms,
    } as FsToolCallInput;
  }

  async #copyChapters(
    sourceId: SessionId,
    targetId: SessionId,
    mode: CopyMode,
  ): Promise<void> {
    const rows = (
      await this.#chapters.list(sourceId, {
        limit: 10_000,
        includeSuperseded: false,
      })
    ).items.filter(
      (chapter) =>
        mode.kind === 'duplicate' ||
        chapter.end_message_seq < mode.beforeSeq,
    );
    if (rows.length === 0) return;
    await this.#chapters.insertRebuilt(
      targetId,
      rows.map((chapter) => ({
        startMessageSeq: chapter.start_message_seq,
        endMessageSeq: chapter.end_message_seq,
        trigger: chapter.trigger,
        title: chapter.title,
        chapterJson: chapter.chapter_json,
        chapterText: chapter.chapter_text,
        resumeJson: chapter.resume_json,
        resumeText: chapter.resume_text,
        version: chapter.version,
        metricsJson: chapter.metrics_json,
        chapterKind: chapter.chapter_kind,
        advancesContextBoundary: chapter.advances_context_boundary === 1,
      })),
    );
  }

  async #copyState(
    sourceState: SessionState | null,
    targetId: SessionId,
    mode: CopyMode,
  ): Promise<void> {
    if (!sourceState) return;
    const target = await this.directory.requireEntry(targetId);
    const boundary = Number(sourceState.compaction.boundary_seq ?? 0);
    const keepCompaction =
      mode.kind === 'duplicate' ||
      (boundary > 0 && boundary < mode.beforeSeq);
    await this.directory.repository.updateState(target.location, (current) => ({
      ...current,
      status: 'idle',
      archived_at: null,
      todos: [],
      permissions: sourceState.permissions,
      tools: sourceState.tools,
      compaction: keepCompaction
        ? sourceState.compaction
        : { boundary_seq: 0, summary: null, kind: null },
      extra: {
        ...sourceState.extra,
        runtime: runtimeForCopy(sourceState),
      },
    }));
  }
}

export type FsSessionOperationsApi = Pick<
  FsSessionOperations,
  'getSessionStats' | 'duplicateSession' | 'forkSessionBeforeSeq'
>;

export function installSessionOperationsApi(
  target: object,
  directory: FsSessionDirectory,
  readStats?: ReadConversationStats,
): void {
  const operations = new FsSessionOperations(directory, readStats);
  for (const name of [
    'getSessionStats',
    'duplicateSession',
    'forkSessionBeforeSeq',
  ] as const) {
    Object.defineProperty(target, name, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: operations[name].bind(operations),
    });
  }
}
