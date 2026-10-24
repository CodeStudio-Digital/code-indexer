import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { err, ok } from '@mcp/code-agent/core/tool.js';
import { isUuid } from '@mcp/session-storage';
import { assertSessionDataCurrent } from './session-data-context.js';
import type {
  FsConversationChapterRow,
} from '@mcp/session-storage/fs-store/history-metrics-types.js';
import type {
  FsCoderMessageRow,
} from '@mcp/session-storage/fs-store/types.js';

const UNAVAILABLE = 'Conversation chapters are not available in this session.';
const MAX_LIST_LIMIT = 50;
const MAX_SOURCE_LIMIT = 20;

function history(ctx: ToolContext) {
  return ctx.conversationHistory ?? null;
}

function limit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

function cursor(value: unknown): string | null | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function chapterId(value: unknown): string | null {
  return typeof value === 'string' && isUuid(value) ? value : null;
}

function chapterHeader(row: FsConversationChapterRow): string {
  return `#${row.ordinal} [id=${row.id}; ${row.source}; ${row.created_at}; messages ${row.start_message_seq}-${row.end_message_seq}] ${row.title}`;
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function safeSourceContent(row: FsCoderMessageRow): unknown {
  const parsed = parseJson(row.content_json);
  if (!Array.isArray(parsed)) return parsed;
  return parsed.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const block = raw as Record<string, unknown>;
    const copy: Record<string, unknown> = { ...block };
    if (typeof copy.base64 === 'string') {
      copy.base64 = `[binary attachment omitted: ${copy.base64.length} base64 chars]`;
    }
    return copy;
  });
}

function renderPageFooter(nextCursor: string | null): string {
  return nextCursor
    ? `\n\nMore results are available. Continue with cursor=${JSON.stringify(nextCursor)}.`
    : '\n\nEnd of results.';
}

export const recallConversationTool: CoderTool = {
  name: 'recall_conversation',
  description:
    'Recover older parts of THIS conversation after compaction. Use mode "list" to browse chapter titles, ' +
    '"search" to find a fact/decision/error by keywords, "get" for one structured chapter plus its resume snapshot, ' +
    'and "source" for the original transcript messages covered by that chapter. Prefer search before re-investigating.',
  source: 'native',
  mutates: false,
  parallelSafe: true,
  repeatable: true,
  riskLevel: 'read',
  outputPolicy: { mode: 'authoritative', reducer: 'none', recovery: 'output_store', preserveOnError: true },
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['list', 'search', 'get', 'source'] },
      query: { type: 'string', description: 'Keywords to search (required for mode=search).' },
      chapter_id: { type: 'string', description: 'Opaque chapter UUID from list/search (required for get/source).' },
      limit: { type: 'number', description: 'Page size. Maximum 50 for chapters and 20 for source messages.' },
      cursor: { type: 'string', description: 'Opaque next cursor returned by the previous call.' },
    },
    required: ['mode'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    assertSessionDataCurrent(ctx);
    const port = history(ctx);
    if (!port) return err(UNAVAILABLE);
    const mode = typeof args.mode === 'string' ? args.mode : '';
    const max = mode === 'source' ? MAX_SOURCE_LIMIT : MAX_LIST_LIMIT;
    if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > max)) return err(`recall_conversation: limit must be an integer between 1 and ${max}.`);
    if (args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length > 2048)) return err('recall_conversation: invalid cursor.');

    try {
      if (mode === 'list') {
        const page = await port.list({
          limit: limit(args.limit, 10, MAX_LIST_LIMIT),
          cursor: cursor(args.cursor),
        });
        assertSessionDataCurrent(ctx);
        if (page.items.length === 0) return ok(`No conversation chapters found.${renderPageFooter(page.next_cursor)}`);
        return ok([
          `Conversation chapters (${page.items.length} in this page):`,
          ...page.items.map(chapterHeader),
        ].join('\n') + renderPageFooter(page.next_cursor));
      }

      if (mode === 'search') {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query || query.length > 2000) return err('recall_conversation: `query` must contain 1-2000 characters for mode="search".');
        const page = await port.search(query, {
          limit: limit(args.limit, 8, MAX_LIST_LIMIT),
          cursor: cursor(args.cursor),
        });
        assertSessionDataCurrent(ctx);
        if (page.items.length === 0) return ok(`No conversation chapter matches ${JSON.stringify(query)}.`);
        const matches = page.items.map((row) => [
          chapterHeader(row),
          row.chapter_text.slice(0, 1_200),
        ].join('\n'));
        const capped = page.items.filter((row) => row.chapter_text.length > 1_200);
        return {
          content: `Matches for ${JSON.stringify(query)}:\n\n${matches.join('\n\n')} ${renderPageFooter(page.next_cursor)}`,
          ...(capped.length > 0
            ? {
                sourceTruncations: [{
                  technique: 'conversation-search-preview',
                  inputSize: capped.reduce((sum, row) => sum + row.chapter_text.length, 0),
                  outputSize: capped.length * 1_200,
                  unit: 'chars' as const,
                  recoverable: true,
                }],
              }
            : {}),
        };
      }

      if (mode === 'get') {
        const id = chapterId(args.chapter_id);
        if (id == null) return err('recall_conversation: UUID `chapter_id` is required for mode="get".');
        const row = await port.get(id);
        assertSessionDataCurrent(ctx);
        if (!row) return err(`Conversation chapter ${id} was not found in this session.`);
        return ok([
          chapterHeader(row),
          '',
          row.chapter_text,
          '',
          '## Resume snapshot after this chapter',
          '',
          row.resume_text,
        ].join('\n'));
      }

      if (mode === 'source') {
        const id = chapterId(args.chapter_id);
        if (id == null) return err('recall_conversation: UUID `chapter_id` is required for mode="source".');
        if (!(await port.get(id))) {
          return err(`Conversation chapter ${id} was not found in this session.`);
        }
        assertSessionDataCurrent(ctx);
        const page = await port.source(id, {
          limit: limit(args.limit, 10, MAX_SOURCE_LIMIT),
          cursor: cursor(args.cursor),
        });
        assertSessionDataCurrent(ctx);
        const rows = page.items.map((row) => JSON.stringify({
          id: row.id,
          seq: row.seq,
          role: row.role,
          is_meta: row.is_meta ?? 0,
          content: safeSourceContent(row),
          created_at: row.created_at,
        }));
        return ok(
          `Original transcript for chapter ${id} (${rows.length} messages in this page):\n${rows.join('\n')}` +
          renderPageFooter(page.next_cursor),
        );
      }

      return err('recall_conversation: invalid `mode`. Use list, search, get, or source.');
    } catch (error) {
      assertSessionDataCurrent(ctx);
      return err(`recall_conversation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

export function buildConversationChapterTools(): CoderTool[] {
  return [recallConversationTool];
}
