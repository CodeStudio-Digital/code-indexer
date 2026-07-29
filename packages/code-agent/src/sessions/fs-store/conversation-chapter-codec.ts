import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertPathHasNoLinksSync,
  isUuid,
  type JsonValue,
  type SessionId,
  type SessionState,
} from '@mcp/session-storage';
import type {
  FsEntityEnvelope,
} from './entity-files.js';
import type {
  FsConversationChapterRow,
  FsConversationChapterSource,
} from './history-metrics-types.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface ChapterData {
  start_message_seq: number;
  end_message_seq: number;
  source: FsConversationChapterSource;
  trigger: string;
  title: string;
  chapter_json: string;
  chapter_text: string;
  resume_json: string;
  resume_text: string;
  version: number;
  metrics_json: string | null;
  superseded_at: string | null;
  chapter_kind: FsConversationChapterRow['chapter_kind'];
  advances_context_boundary: 0 | 1;
}

export interface FsChapterBoundaryProjection {
  boundary_seq: number;
  resume_text: string | null;
}

export function finiteInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : 0;
}

export function pageLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value!)));
}

export function chapterCursor(prefix: string, value: number): string {
  return `${prefix}:${value}`;
}

export function parseChapterCursor(
  value: string | null | undefined,
  prefix: string,
): number | null {
  if (!value) return null;
  const match = new RegExp(`^${prefix}:(\\d+)$`).exec(value);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function chapterRow(
  sessionId: SessionId,
  envelope: FsEntityEnvelope<JsonValue>,
): FsConversationChapterRow {
  const data = envelope.data as unknown as ChapterData;
  return {
    id: envelope.id,
    seq: envelope.seq,
    revision: envelope.revision,
    session_id: sessionId,
    ordinal: envelope.seq,
    start_message_seq: data.start_message_seq,
    end_message_seq: data.end_message_seq,
    source: data.source,
    trigger: data.trigger,
    title: data.title,
    chapter_json: data.chapter_json,
    chapter_text: data.chapter_text,
    resume_json: data.resume_json,
    resume_text: data.resume_text,
    version: data.version,
    metrics_json: data.metrics_json,
    created_at: envelope.created_at,
    superseded_at: data.superseded_at,
    chapter_kind: data.chapter_kind,
    advances_context_boundary: data.advances_context_boundary,
  };
}

export function activeBoundary(
  state: SessionState,
  chapters: readonly FsConversationChapterRow[],
): FsChapterBoundaryProjection {
  const stateBoundary = finiteInteger(state.compaction.boundary_seq);
  const active = chapters
    .filter(
      (chapter) =>
        chapter.superseded_at == null &&
        chapter.advances_context_boundary === 1,
    )
    .sort((left, right) => right.end_message_seq - left.end_message_seq)[0];
  if (!active || active.end_message_seq < stateBoundary) {
    return {
      boundary_seq: stateBoundary,
      resume_text:
        typeof state.compaction.summary === 'string'
          ? state.compaction.summary
          : null,
    };
  }
  return {
    boundary_seq: active.end_message_seq,
    resume_text: active.resume_text,
  };
}

/**
 * Recovery projection used by transcript reads. A committed chapter is the
 * canonical checkpoint, so a crash between its fsync and state.json's rename
 * cannot expose archived messages again after restart.
 */
export function readChapterBoundarySync(
  bundlePath: string,
  state: SessionState,
): FsChapterBoundaryProjection {
  const root = join(bundlePath, 'chapters');
  assertPathHasNoLinksSync(bundlePath, root);
  const rows = readdirSync(root)
    .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
    .map((name) => {
      const path = join(root, name);
      assertPathHasNoLinksSync(bundlePath, path);
      const envelope = JSON.parse(
        readFileSync(path, 'utf8'),
      ) as FsEntityEnvelope<JsonValue>;
      const data = envelope.data as unknown as ChapterData;
      if (
        envelope.schema_version !== 1 ||
        !isUuid(envelope.id) ||
        !Number.isSafeInteger(envelope.seq) ||
        envelope.seq < 1 ||
        envelope.kind !== 'conversation_chapter' ||
        !Number.isSafeInteger(data.end_message_seq) ||
        data.end_message_seq < 1 ||
        typeof data.resume_text !== 'string' ||
        (data.superseded_at !== null &&
          typeof data.superseded_at !== 'string') ||
        (data.advances_context_boundary !== 0 &&
          data.advances_context_boundary !== 1)
      ) {
        throw new Error(`Invalid conversation chapter checkpoint ${path}`);
      }
      return {
        end_message_seq: data.end_message_seq,
        resume_text: data.resume_text,
        superseded_at: data.superseded_at,
        advances_context_boundary: data.advances_context_boundary,
        deleted_at: envelope.deleted_at,
      };
    })
    .filter(
      (row) =>
        row.deleted_at == null &&
        row.superseded_at == null &&
        row.advances_context_boundary === 1 &&
        Number.isSafeInteger(row.end_message_seq) &&
        row.end_message_seq > 0,
    )
    .sort((left, right) => right.end_message_seq - left.end_message_seq);
  const top = rows[0];
  const stateBoundary = finiteInteger(state.compaction.boundary_seq);
  return top && top.end_message_seq >= stateBoundary
    ? {
        boundary_seq: top.end_message_seq,
        resume_text: top.resume_text,
      }
    : {
        boundary_seq: stateBoundary,
        resume_text:
          typeof state.compaction.summary === 'string'
            ? state.compaction.summary
            : null,
      };
}

export function normalizeSearchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .normalize('NFKD')
        .toLocaleLowerCase()
        .replaceAll(/[^\p{L}\p{N}_-]+/gu, ' ')
        .split(/\s+/)
        .filter((term) => term.length > 1)
        .slice(0, 24),
    ),
  ];
}

export function searchableChapterText(
  chapter: FsConversationChapterRow,
): string {
  return [
    chapter.title,
    chapter.chapter_text,
    chapter.resume_text,
    chapter.trigger,
  ]
    .join('\n')
    .normalize('NFKD')
    .toLocaleLowerCase();
}

export function chapterSearchRank(
  text: string,
  terms: readonly string[],
): number {
  let score = 0;
  for (const term of terms) {
    let from = 0;
    let count = 0;
    while (count < 100) {
      const index = text.indexOf(term, from);
      if (index < 0) break;
      count += 1;
      from = index + term.length;
    }
    score += count;
  }
  return score;
}
