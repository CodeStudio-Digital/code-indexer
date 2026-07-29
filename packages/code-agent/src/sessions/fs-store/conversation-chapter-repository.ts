import {
  asSessionId,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import {
  activeBoundary,
  chapterCursor,
  chapterRow,
  chapterSearchRank,
  finiteInteger,
  normalizeSearchTerms,
  pageLimit,
  parseChapterCursor,
  searchableChapterText,
  type ChapterData,
} from './conversation-chapter-codec.js';
import {
  hydrateMessage,
  messageRow,
  projectConversation,
} from './conversation-codec.js';
import { FsSessionEntityFiles } from './entity-files.js';
import { FsConversationChapterRebuildRepository } from './conversation-chapter-rebuild-repository.js';
import type {
  FsCommitConversationChapterInput,
  FsCommitConversationChapterResult,
  FsConversationChapterPage,
  FsConversationChapterRow,
  FsConversationChapterSearchResult,
  FsConversationChapterSourcePage,
  FsInsertRebuiltConversationChaptersResult,
  FsRebuiltConversationChapterInput,
} from './history-metrics-types.js';
import { FsSessionDirectory } from './session-directory.js';

export class FsConversationChapterRepository {
  private readonly rebuilds: FsConversationChapterRebuildRepository;

  constructor(
    private readonly directory: FsSessionDirectory,
    private readonly entities: FsSessionEntityFiles,
  ) {
    this.rebuilds = new FsConversationChapterRebuildRepository(
      directory,
      entities,
    );
  }

  private async rows(
    sessionId: SessionId | string,
    includeSuperseded = false,
  ): Promise<FsConversationChapterRow[]> {
    return (
      await this.entities.list<JsonValue>(
        sessionId,
        'chapters',
        'conversation_chapter',
      )
    )
      .map((item) => chapterRow(asSessionId(String(sessionId)), item))
      .filter(
        (item) => includeSuperseded || item.superseded_at == null,
      )
      .sort((left, right) => left.seq - right.seq);
  }

  async commit(
    input: FsCommitConversationChapterInput,
  ): Promise<FsCommitConversationChapterResult> {
    const expected = input.expectedBoundarySeq;
    const start = input.startMessageSeq;
    const end = input.endMessageSeq;
    if (
      !Number.isSafeInteger(expected) ||
      expected < 0 ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start <= 0 ||
      end < start
    ) {
      throw new RangeError(`invalid chapter span ${start}..${end}`);
    }
    if (!Number.isSafeInteger(input.version) || input.version <= 0) {
      throw new RangeError(`invalid chapter version ${input.version}`);
    }
    if (
      !input.title.trim() ||
      !input.chapterText.trim() ||
      !input.resumeText.trim()
    ) {
      throw new Error(
        'chapter title, chapterText, and resumeText must not be empty',
      );
    }
    const data: ChapterData = {
      start_message_seq: start,
      end_message_seq: end,
      source: input.source,
      trigger: input.trigger,
      title: input.title,
      chapter_json: input.chapterJson,
      chapter_text: input.chapterText,
      resume_json: input.resumeJson,
      resume_text: input.resumeText,
      version: input.version,
      metrics_json: input.metricsJson ?? null,
      superseded_at: null,
      chapter_kind:
        input.chapterKind ??
        (input.trigger.startsWith('milestone:')
          ? 'milestone'
          : 'context'),
      advances_context_boundary: 1,
    };
    const operationId =
      input.operation_id ??
      `chapter:${input.sessionId}:${expected}:${start}:${end}`;
    const operationKey = {
      action: 'commit_chapter',
      expected,
      start,
      end,
      data,
    };

    return this.directory.runMutation(input.sessionId, async () => {
      const entry = await this.directory.requireEntry(input.sessionId);
      const state =
        entry.state ??
        this.directory.repository.readStateSync(entry.location);
      const chapters = await this.rows(input.sessionId, true);
      const projection = activeBoundary(state, chapters);
      const duplicate = chapters.find(
        (chapter) =>
          chapter.end_message_seq === end &&
          chapter.superseded_at == null &&
          chapter.advances_context_boundary === 1,
      );
      if (duplicate) {
        const duplicateEnvelope = await this.entities.get<JsonValue>(
          input.sessionId,
          'chapters',
          duplicate.id,
          true,
        );
        if (
          duplicateEnvelope?.operation_history.some(
            (operation) => operation.operation_id === operationId,
          )
        ) {
          // Re-run the operation guard so the same operation_id with a
          // different payload fails instead of masquerading as a replay.
          await this.entities.createWithinMutation(
            input.sessionId,
            'chapters',
            {
              kind: 'conversation_chapter',
              data,
              operation_id: operationId,
              operation_key: operationKey,
            },
          );
        }
        await this.repairBoundary(
          input.sessionId,
          entry.location,
          duplicate,
        );
        await this.supersedeCoveredRebuildsWithinMutation(
          input.sessionId,
          start,
          end,
          duplicate.id,
        );
        return {
          status: 'noop',
          reason: 'already_committed',
          chapter: duplicate,
          boundary_seq: Math.max(
            projection.boundary_seq,
            duplicate.end_message_seq,
          ),
          pruned_count: 0,
        };
      }
      if (projection.boundary_seq !== expected || end <= projection.boundary_seq) {
        return {
          status: 'noop',
          reason: 'boundary_changed',
          boundary_seq: projection.boundary_seq,
          pruned_count: 0,
        };
      }

      const conversation = projectConversation(
        this.directory.repository.readConversationSync(entry.location),
      );
      const span = conversation.storedMessages
        .map((stored) => ({ stored, seq: stored.seq }))
        .filter(
          (message) =>
            message.seq > projection.boundary_seq &&
            message.seq <= end,
        );
      if (span.length === 0) {
        return {
          status: 'noop',
          reason: 'no_messages',
          boundary_seq: projection.boundary_seq,
          pruned_count: 0,
        };
      }
      if (span[0].seq !== start || span.at(-1)!.seq !== end) {
        throw new RangeError(
          `chapter span must cover all new messages: expected ${span[0].seq}..${span.at(-1)!.seq}, got ${start}..${end}`,
        );
      }

      const created = await this.entities.createWithinMutation(
        input.sessionId,
        'chapters',
        {
          kind: 'conversation_chapter',
          data,
          operation_id: operationId,
          operation_key: operationKey,
        },
      );
      const chapter = chapterRow(input.sessionId, created);

      // The chapter file is the canonical crash checkpoint. state.json is its
      // mutable projection and is repaired from the chapter on replay/restart.
      await this.repairBoundary(
        input.sessionId,
        entry.location,
        chapter,
      );
      await this.supersedeCoveredRebuildsWithinMutation(
        input.sessionId,
        start,
        end,
        chapter.id,
      );
      return {
        status: 'committed',
        chapter,
        boundary_seq: end,
        pruned_count: span.length,
      };
    });
  }

  async insertRebuilt(
    sessionId: SessionId | string,
    input: readonly FsRebuiltConversationChapterInput[],
  ): Promise<FsInsertRebuiltConversationChaptersResult> {
    return this.rebuilds.insert(sessionId, input);
  }

  private async repairBoundary(
    sessionId: SessionId,
    location: Awaited<
      ReturnType<FsSessionDirectory['requireEntry']>
    >['location'],
    chapter: FsConversationChapterRow,
  ): Promise<void> {
    const advancing = (await this.rows(sessionId, true)).filter(
      (candidate) =>
        candidate.superseded_at == null &&
        candidate.advances_context_boundary === 1 &&
        candidate.end_message_seq <= chapter.end_message_seq,
    );
    await this.directory.repository.updateState(location, (state) => {
      const current = finiteInteger(state.compaction.boundary_seq);
      if (current >= chapter.end_message_seq) return state;
      const newlyProjected = advancing.filter(
        (candidate) => candidate.end_message_seq > current,
      );
      return {
        ...state,
        compaction: {
          ...state.compaction,
          boundary_seq: chapter.end_message_seq,
          summary: chapter.resume_text,
          count_auto:
            finiteInteger(state.compaction.count_auto) +
            newlyProjected.filter(
              (candidate) => candidate.source === 'auto',
            ).length,
          count_manual:
            finiteInteger(state.compaction.count_manual) +
            newlyProjected.filter(
              (candidate) => candidate.source === 'manual',
            ).length,
        },
        extra: {
          ...state.extra,
          runtime: {
            ...(state.extra.runtime &&
            typeof state.extra.runtime === 'object' &&
            !Array.isArray(state.extra.runtime)
              ? state.extra.runtime
              : {}),
            last_response_id: null,
            last_response_message_count: null,
          },
        },
      };
    });
  }

  private async supersedeCoveredRebuildsWithinMutation(
    sessionId: SessionId,
    start: number,
    end: number,
    committedId: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const rebuilds = (await this.rows(sessionId, true)).filter(
      (chapter) =>
        chapter.id !== committedId &&
        chapter.source === 'rebuild' &&
        chapter.superseded_at == null &&
        chapter.start_message_seq >= start &&
        chapter.end_message_seq <= end,
    );
    for (const chapter of rebuilds) {
      await this.entities.updateWithinMutation<ChapterData>(
        sessionId,
        'chapters',
        chapter.id,
        (current) => ({ ...current, superseded_at: now }),
        {
          operation_id: `chapter-supersede:${committedId}:${chapter.id}`,
          operation_key: {
            action: 'covered_by_context_chapter',
            committed_id: committedId,
          },
        },
      );
    }
  }

  async list(
    sessionId: SessionId | string,
    options: {
      limit?: number;
      cursor?: string | null;
      includeSuperseded?: boolean;
    } = {},
  ): Promise<FsConversationChapterPage<FsConversationChapterRow>> {
    const limit = pageLimit(options.limit);
    const beforeSeq = parseChapterCursor(options.cursor, 'chapter');
    const rows = (await this.rows(
      sessionId,
      options.includeSuperseded === true,
    ))
      .filter((chapter) => beforeSeq == null || chapter.seq < beforeSeq)
      .sort((left, right) => right.seq - left.seq);
    const items = rows.slice(0, limit);
    return {
      items,
      next_cursor:
        rows.length > limit && items.length > 0
          ? chapterCursor('chapter', items.at(-1)!.seq)
          : null,
    };
  }

  async count(
    sessionId: SessionId | string,
    includeSuperseded = false,
  ): Promise<number> {
    return (await this.rows(sessionId, includeSuperseded)).length;
  }

  async search(
    sessionId: SessionId | string,
    query: string,
    options: { limit?: number; cursor?: string | null } = {},
  ): Promise<
    FsConversationChapterPage<FsConversationChapterSearchResult>
  > {
    const terms = normalizeSearchTerms(query);
    if (terms.length === 0) return { items: [], next_cursor: null };
    const limit = pageLimit(options.limit);
    const offset = parseChapterCursor(options.cursor, 'search') ?? 0;
    const candidates = (await this.rows(sessionId))
      .map((chapter) => {
        const text = searchableChapterText(chapter);
        const hits = terms.map((term) => text.includes(term));
        return {
          ...chapter,
          rank: chapterSearchRank(text, terms),
          all: hits.every(Boolean),
          any: hits.some(Boolean),
        };
      });
    const exact = candidates.filter((row) => row.all);
    const selected = (exact.length > 0
      ? exact
      : candidates.filter((row) => row.any))
      .sort(
        (left, right) =>
          right.rank - left.rank || right.seq - left.seq,
      )
      .map(({ all: _all, any: _any, ...row }) => row);
    const items = selected.slice(offset, offset + limit);
    return {
      items,
      next_cursor:
        selected.length > offset + limit
          ? chapterCursor('search', offset + limit)
          : null,
    };
  }

  async get(
    sessionId: SessionId | string,
    chapterId: string,
  ): Promise<FsConversationChapterRow | null> {
    const item = await this.entities.get<JsonValue>(
      sessionId,
      'chapters',
      chapterId,
    );
    return item && item.kind === 'conversation_chapter'
      ? chapterRow(asSessionId(String(sessionId)), item)
      : null;
  }

  async listSource(
    sessionId: SessionId | string,
    chapterId: string,
    options: { limit?: number; cursor?: string | null } = {},
  ): Promise<FsConversationChapterSourcePage> {
    const chapter = await this.get(sessionId, chapterId);
    if (!chapter) return { items: [], next_cursor: null };
    const entry = await this.directory.requireEntry(sessionId);
    const conversation = projectConversation(
      this.directory.repository.readConversationSync(entry.location),
    );
    const messages = conversation.storedMessages.map((stored) =>
      hydrateMessage(entry.location, stored),
    );
    const rows = conversation.storedMessages.map((stored, index) =>
      messageRow(
        entry.session.id,
        stored,
        messages[index],
      ),
    );
    const afterSeq =
      parseChapterCursor(options.cursor, 'message') ?? 0;
    const limit = pageLimit(options.limit);
    const selected = rows.filter(
      (row) =>
        row.seq >= chapter.start_message_seq &&
        row.seq <= chapter.end_message_seq &&
        row.seq > afterSeq,
    );
    const items = selected.slice(0, limit);
    return {
      items,
      next_cursor:
        selected.length > limit && items.length > 0
          ? chapterCursor('message', items.at(-1)!.seq)
          : null,
    };
  }
}
