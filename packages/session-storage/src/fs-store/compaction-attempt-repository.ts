import {
  asAgentRunId,
  asSessionId,
  isUuid,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import { readChapterBoundarySync } from './conversation-chapter-codec.js';
import { FsConversationReader } from './conversation-reader.js';
import {
  FsConversationChapterRepository,
} from './conversation-chapter-repository.js';
import {
  FsSessionEntityFiles,
  type FsEntityEnvelope,
} from './entity-files.js';
import type {
  FsCompactionAttemptRow,
  FsConversationChapterRow,
  FsConversationChapterStatus,
  FsFinishCompactionAttemptInput,
  FsStartCompactionAttemptInput,
} from './history-metrics-types.js';
import { FsSessionDirectory } from './session-directory.js';

interface CompactionAttemptData {
  run_id: string;
  turn: number;
  turn_telemetry_id: string | null;
  trigger: string;
  provider_chain: ReadonlyArray<{
    provider: string;
    model: string;
  }>;
  summary_provider: string | null;
  summary_model: string | null;
  status: FsCompactionAttemptRow['status'];
  strategy: FsCompactionAttemptRow['strategy'];
  summarizer_ran: boolean;
  prompt_tokens_before: number | null;
  history_chars_before: number | null;
  history_chars_after: number | null;
  pruned_messages: number;
  chapter_id: string | null;
  boundary_seq: number | null;
  error_message: string | null;
  finished_at: string | null;
}

function nullableInteger(
  value: number | null | undefined,
): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function attemptRow(
  sessionId: SessionId,
  envelope: FsEntityEnvelope<JsonValue>,
): FsCompactionAttemptRow {
  const data = envelope.data as unknown as CompactionAttemptData;
  const telemetryId = data.turn_telemetry_id;
  if (telemetryId != null && !isUuid(telemetryId)) {
    throw new TypeError('turn_telemetry_id must be a UUID');
  }
  return {
    id: envelope.id,
    seq: envelope.seq,
    revision: envelope.revision,
    session_id: sessionId,
    run_id: asAgentRunId(data.run_id),
    turn: data.turn,
    turn_telemetry_id: data.turn_telemetry_id,
    trigger: data.trigger,
    provider_chain: data.provider_chain,
    summary_provider: data.summary_provider,
    summary_model: data.summary_model,
    status: data.status,
    strategy: data.strategy,
    summarizer_ran: data.summarizer_ran,
    prompt_tokens_before: data.prompt_tokens_before,
    history_chars_before: data.history_chars_before,
    history_chars_after: data.history_chars_after,
    pruned_messages: data.pruned_messages,
    chapter_id: data.chapter_id,
    boundary_seq: data.boundary_seq,
    error_message: data.error_message,
    created_at: envelope.created_at,
    finished_at: data.finished_at,
  };
}

export class FsCompactionAttemptRepository {
  constructor(
    private readonly directory: FsSessionDirectory,
    private readonly entities: FsSessionEntityFiles,
    private readonly chapters: FsConversationChapterRepository,
    private readonly reader = new FsConversationReader(directory),
  ) {}

  async start(
    input: FsStartCompactionAttemptInput,
  ): Promise<string | null> {
    try {
      const runId = asAgentRunId(input.run_id);
      const telemetryId = input.turn_telemetry_id ?? null;
      if (telemetryId != null && !isUuid(telemetryId)) {
        throw new TypeError('turn_telemetry_id must be a UUID');
      }
      if (!Number.isSafeInteger(input.turn) || input.turn < 0) {
        throw new RangeError(`invalid compaction turn ${input.turn}`);
      }
      const trigger = input.trigger ?? '';
      const data: CompactionAttemptData = {
        run_id: runId,
        turn: input.turn,
        turn_telemetry_id: telemetryId?.toLowerCase() ?? null,
        trigger,
        provider_chain: [...(input.provider_chain ?? [])],
        summary_provider: null,
        summary_model: null,
        status: 'started',
        strategy: 'none',
        summarizer_ran: false,
        prompt_tokens_before: nullableInteger(input.prompt_tokens_before),
        history_chars_before: nullableInteger(input.history_chars_before),
        history_chars_after: null,
        pruned_messages: 0,
        chapter_id: null,
        boundary_seq: null,
        error_message: null,
        finished_at: null,
      };
      const saved = await this.entities.create(
        input.session_id,
        'checkpoints',
        {
          kind: 'compaction_attempt',
          data,
          operation_id:
            input.operation_id ??
            `compaction-start:${runId}:${input.turn}:${trigger}`,
          operation_key: {
            action: 'start_compaction_attempt',
            ...data,
          },
        },
      );
      return saved.id;
    } catch (error) {
      console.warn(
        `[coder] startCompactionAttempt failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  async finish(
    sessionId: SessionId | string,
    attemptId: string | null,
    input: FsFinishCompactionAttemptInput,
  ): Promise<void> {
    if (attemptId == null) return;
    if (!isUuid(attemptId)) {
      console.warn(
        `[coder] finishCompactionAttempt ignored invalid UUID ${attemptId}`,
      );
      return;
    }
    try {
      const finishedAt = new Date().toISOString();
      const operationKey = {
        action: 'finish_compaction_attempt',
        status: input.status,
        strategy: input.strategy,
        summarizer_ran: input.summarizer_ran,
        summary_provider: input.summary_provider ?? null,
        summary_model: input.summary_model ?? null,
        history_chars_after: nullableInteger(input.history_chars_after),
        pruned_messages: nullableInteger(input.pruned_messages) ?? 0,
        chapter_id: input.chapter_id ?? null,
        boundary_seq: nullableInteger(input.boundary_seq),
        error_message: input.error_message?.slice(0, 2_000) ?? null,
      };
      await this.entities.update<CompactionAttemptData>(
        sessionId,
        'checkpoints',
        attemptId,
        (current) => ({
          ...current,
          status: input.status,
          strategy: input.strategy,
          summarizer_ran: input.summarizer_ran,
          summary_provider: input.summary_provider ?? null,
          summary_model: input.summary_model ?? null,
          history_chars_after: nullableInteger(
            input.history_chars_after,
          ),
          pruned_messages: nullableInteger(input.pruned_messages) ?? 0,
          chapter_id: input.chapter_id ?? null,
          boundary_seq: nullableInteger(input.boundary_seq),
          error_message:
            input.error_message?.slice(0, 2_000) ?? null,
          finished_at: current.finished_at ?? finishedAt,
        }),
        {
          operation_id:
            input.operation_id ?? `compaction-finish:${attemptId}`,
          operation_key: operationKey,
        },
      );
    } catch (error) {
      console.warn(
        `[coder] finishCompactionAttempt failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async list(
    sessionId: SessionId | string,
  ): Promise<FsCompactionAttemptRow[]> {
    return (
      await this.entities.list<JsonValue>(
        sessionId,
        'checkpoints',
        'compaction_attempt',
      )
    ).map((item) => attemptRow(asSessionId(String(sessionId)), item));
  }

  async latest(
    sessionId: SessionId | string,
  ): Promise<FsCompactionAttemptRow | null> {
    return (await this.list(sessionId)).at(-1) ?? null;
  }

  async chapterStatus(
    sessionId: SessionId | string,
  ): Promise<FsConversationChapterStatus> {
    const entry = await this.directory.requireEntry(sessionId);
    const session = this.directory.map(entry);
    const boundary = readChapterBoundarySync(
      entry.location.bundle_path,
      session.state,
    ).boundary_seq;
    const chapters: FsConversationChapterRow[] = [];
    let chapterCursor: string | null = null;
    do {
      const page = await this.chapters.list(sessionId, {
        limit: 100,
        cursor: chapterCursor,
        includeSuperseded: false,
      });
      chapters.push(...page.items);
      chapterCursor = page.next_cursor;
    } while (chapterCursor);
    const unsummarized = await this.reader.count(sessionId, boundary);
    const attempts = await this.list(sessionId);
    const counters = {
      attempts: attempts.filter(
        (attempt) => !attempt.trigger.startsWith('checkpoint_retry:'),
      ).length,
      summarized: attempts.filter(
        (attempt) =>
          attempt.summarizer_ran &&
          attempt.strategy === 'summarizer' &&
          (attempt.status === 'summarized' ||
            attempt.status === 'checkpoint_failed'),
      ).length,
      deterministic_fallbacks: attempts.filter(
        (attempt) => attempt.status === 'deterministic_fallback',
      ).length,
      checkpoint_failures: attempts.filter(
        (attempt) =>
          attempt.status === 'checkpoint_failed' &&
          !attempt.trigger.startsWith('checkpoint_retry:') &&
          !attempt.error_message?.startsWith(
            'prior checkpoint still pending:',
          ),
      ).length,
      checkpoint_retries: attempts.filter((attempt) =>
        attempt.trigger.startsWith('checkpoint_retry:'),
      ).length,
      checkpoint_blocked: attempts.filter((attempt) =>
        attempt.error_message?.startsWith(
          'prior checkpoint still pending:',
        ),
      ).length,
      noops: attempts.filter((attempt) => attempt.status === 'noop')
        .length,
      failures: attempts.filter(
        (attempt) =>
          attempt.error_message != null &&
          !attempt.trigger.startsWith('checkpoint_retry:') &&
          !attempt.error_message.startsWith(
            'prior checkpoint still pending:',
          ),
      ).length,
    };
    const lastAttempt = attempts.at(-1) ?? null;
    const degraded =
      lastAttempt?.status === 'deterministic_fallback' ||
      lastAttempt?.status === 'checkpoint_failed' ||
      lastAttempt?.status === 'started' ||
      (lastAttempt?.status === 'noop' &&
        lastAttempt.error_message != null);
    return {
      state: degraded
        ? 'degraded'
        : chapters.length > 0
          ? 'healthy'
          : 'empty',
      boundary_seq: boundary || null,
      unsummarized_messages: unsummarized,
      chapter_count: chapters.length,
      context_chapters: chapters.filter(
        (chapter) => chapter.chapter_kind === 'context',
      ).length,
      milestone_chapters: chapters.filter(
        (chapter) => chapter.chapter_kind === 'milestone',
      ).length,
      rebuilt_chapters: chapters.filter(
        (chapter) => chapter.chapter_kind === 'rebuild',
      ).length,
      counters,
      last_attempt: lastAttempt,
    };
  }
}
