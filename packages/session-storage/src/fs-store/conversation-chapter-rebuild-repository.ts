import {
  asSessionId,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import {
  activeBoundary,
  chapterRow,
  type ChapterData,
} from './conversation-chapter-codec.js';
import { projectConversation } from './conversation-codec.js';
import { FsSessionEntityFiles } from './entity-files.js';
import type {
  FsConversationChapterRow,
  FsInsertRebuiltConversationChaptersResult,
  FsRebuiltConversationChapterInput,
} from './history-metrics-types.js';
import { FsSessionDirectory } from './session-directory.js';

export class FsConversationChapterRebuildRepository {
  constructor(
    private readonly directory: FsSessionDirectory,
    private readonly entities: FsSessionEntityFiles,
  ) {}

  private async rows(
    sessionId: SessionId | string,
  ): Promise<FsConversationChapterRow[]> {
    return (
      await this.entities.list<JsonValue>(
        sessionId,
        'chapters',
        'conversation_chapter',
      )
    )
      .map((item) => chapterRow(asSessionId(String(sessionId)), item))
      .sort((left, right) => left.seq - right.seq);
  }

  private validate(
    input: readonly FsRebuiltConversationChapterInput[],
  ): FsRebuiltConversationChapterInput[] {
    const ordered = [...input].sort(
      (left, right) => left.startMessageSeq - right.startMessageSeq,
    );
    let previousEnd = 0;
    for (const chapter of ordered) {
      if (
        !Number.isSafeInteger(chapter.startMessageSeq) ||
        !Number.isSafeInteger(chapter.endMessageSeq) ||
        chapter.startMessageSeq <= previousEnd ||
        chapter.endMessageSeq < chapter.startMessageSeq
      ) {
        throw new RangeError(
          'rebuilt chapter ranges must be valid and non-overlapping',
        );
      }
      if (
        !chapter.title.trim() ||
        !chapter.chapterText.trim() ||
        !chapter.resumeText.trim()
      ) {
        throw new Error(
          'rebuilt chapter title, chapterText, and resumeText must not be empty',
        );
      }
      if (
        !Number.isSafeInteger(chapter.version) ||
        chapter.version <= 0
      ) {
        throw new RangeError(
          `invalid rebuilt chapter version ${chapter.version}`,
        );
      }
      previousEnd = chapter.endMessageSeq;
    }
    return ordered;
  }

  async insert(
    sessionId: SessionId | string,
    input: readonly FsRebuiltConversationChapterInput[],
  ): Promise<FsInsertRebuiltConversationChaptersResult> {
    if (input.length === 0) {
      return { items: [], superseded_count: 0 };
    }
    const ordered = this.validate(input);
    return this.directory.runMutation(sessionId, async () => {
      const entry = await this.directory.requireEntry(sessionId);
      const state =
        entry.state ??
        this.directory.repository.readStateSync(entry.location);
      const allChapters = await this.rows(sessionId);
      const boundary = activeBoundary(state, allChapters).boundary_seq;
      if (
        ordered.some(
          (chapter) => chapter.advancesContextBoundary === true,
        ) &&
        ordered.at(-1)!.endMessageSeq > boundary
      ) {
        throw new RangeError(
          'rebuilt chapters cannot extend beyond the durable boundary',
        );
      }

      const messageCount = projectConversation(
        this.directory.repository.readConversationSync(entry.location),
      ).storedMessages.length;
      for (const chapter of ordered) {
        if (
          chapter.startMessageSeq < 1 ||
          chapter.endMessageSeq > messageCount
        ) {
          throw new RangeError(
            `rebuilt chapter ${chapter.startMessageSeq}..${chapter.endMessageSeq} is not backed by session messages`,
          );
        }
      }

      const existing = allChapters.filter(
        (chapter) =>
          chapter.source === 'rebuild' &&
          chapter.superseded_at == null,
      );
      const exactRetry =
        existing.length === ordered.length &&
        existing.every(
          (chapter, index) =>
            chapter.start_message_seq ===
              ordered[index]!.startMessageSeq &&
            chapter.end_message_seq === ordered[index]!.endMessageSeq,
        );
      if (exactRetry) {
        return { items: existing, superseded_count: 0 };
      }

      const first = ordered[0]!.startMessageSeq;
      const last = ordered.at(-1)!.endMessageSeq;
      const supersededAt = new Date().toISOString();
      const superseded = allChapters.filter(
        (chapter) =>
          (chapter.source === 'legacy' ||
            chapter.source === 'rebuild') &&
          chapter.superseded_at == null &&
          chapter.start_message_seq <= last &&
          chapter.end_message_seq >= first,
      );
      for (const chapter of superseded) {
        await this.entities.updateWithinMutation<ChapterData>(
          sessionId,
          'chapters',
          chapter.id,
          (current) => ({
            ...current,
            superseded_at: supersededAt,
          }),
          {
            operation_id:
              `chapter-rebuild-supersede:${sessionId}:${first}:${last}:${chapter.id}`,
            operation_key: {
              action: 'supersede_for_rebuild',
              first,
              last,
            },
          },
        );
      }

      const items: FsConversationChapterRow[] = [];
      for (const chapter of ordered) {
        const created = await this.entities.createWithinMutation(
          sessionId,
          'chapters',
          {
            kind: 'conversation_chapter',
            data: {
              start_message_seq: chapter.startMessageSeq,
              end_message_seq: chapter.endMessageSeq,
              source: 'rebuild',
              trigger: chapter.trigger,
              title: chapter.title,
              chapter_json: chapter.chapterJson,
              chapter_text: chapter.chapterText,
              resume_json: chapter.resumeJson,
              resume_text: chapter.resumeText,
              version: chapter.version,
              metrics_json: chapter.metricsJson ?? null,
              superseded_at: null,
              chapter_kind: chapter.chapterKind ?? 'rebuild',
              advances_context_boundary:
                chapter.advancesContextBoundary === true ? 1 : 0,
            } satisfies ChapterData,
            operation_id:
              `chapter-rebuild:${sessionId}:${chapter.startMessageSeq}:${chapter.endMessageSeq}:${chapter.version}`,
            operation_key: {
              action: 'insert_rebuilt_chapter',
              start: chapter.startMessageSeq,
              end: chapter.endMessageSeq,
              version: chapter.version,
            },
          },
        );
        items.push(chapterRow(asSessionId(String(sessionId)), created));
      }
      return { items, superseded_count: superseded.length };
    });
  }
}
