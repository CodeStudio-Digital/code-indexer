import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { err, ok } from '@mcp/code-agent/core/tool.js';
import type { CoderMessageRow, ConversationChapterRow } from '@mcp/code-agent/sessions/types.js';

const UNAVAILABLE = 'Conversation chapters are not available in this session.';
const MAX_LIST_LIMIT = 50;
const MAX_SOURCE_LIMIT = 20;
const SOURCE_BLOCK_CAP = 8_000;

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

function chapterId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function chapterHeader(row: ConversationChapterRow): string {
  return `#${row.ordinal} [id=${row.id}; ${row.source}; ${row.created_at}; messages ${row.start_message_id}-${row.end_message_id}] ${row.title}`;
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function safeSourceContent(row: CoderMessageRow): unknown {
  const parsed = parseJson(row.content_json);
  if (!Array.isArray(parsed)) return parsed;
  return parsed.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const block = raw as Record<string, unknown>;
    const copy: Record<string, unknown> = { ...block };
    if (typeof copy.base64 === 'string') {
      copy.base64 = `[binary attachment omitted: ${copy.base64.length} base64 chars]`;
    }
    if (typeof copy.content === 'string' && copy.content.length > SOURCE_BLOCK_CAP) {
      copy.content = `${copy.content.slice(0, SOURCE_BLOCK_CAP)}\n[message block truncated; ${copy.content.length - SOURCE_BLOCK_CAP} chars omitted]`;
    }
    if (typeof copy.text === 'string' && copy.text.length > SOURCE_BLOCK_CAP) {
      copy.text = `${copy.text.slice(0, SOURCE_BLOCK_CAP)}\n[message block truncated; ${copy.text.length - SOURCE_BLOCK_CAP} chars omitted]`;
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
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['list', 'search', 'get', 'source'] },
      query: { type: 'string', description: 'Keywords to search (required for mode=search).' },
      chapter_id: { type: 'number', description: 'Chapter id from list/search (required for get/source).' },
      limit: { type: 'number', description: 'Page size. Maximum 50 for chapters and 20 for source messages.' },
      cursor: { type: 'string', description: 'Opaque next cursor returned by the previous call.' },
    },
    required: ['mode'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const port = history(ctx);
    if (!port) return err(UNAVAILABLE);
    const mode = typeof args.mode === 'string' ? args.mode : '';

    try {
      if (mode === 'list') {
        const page = port.list({
          limit: limit(args.limit, 10, MAX_LIST_LIMIT),
          cursor: cursor(args.cursor),
        });
        if (page.items.length === 0) return ok(`No conversation chapters found.${renderPageFooter(page.next_cursor)}`);
        return ok([
          `Conversation chapters (${page.items.length} in this page):`,
          ...page.items.map(chapterHeader),
        ].join('\n') + renderPageFooter(page.next_cursor));
      }

      if (mode === 'search') {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) return err('recall_conversation: `query` is required for mode="search".');
        const page = port.search(query, {
          limit: limit(args.limit, 8, MAX_LIST_LIMIT),
          cursor: cursor(args.cursor),
        });
        if (page.items.length === 0) return ok(`No conversation chapter matches ${JSON.stringify(query)}.`);
        const matches = page.items.map((row) => [
          chapterHeader(row),
          row.chapter_text.slice(0, 1_200),
        ].join('\n'));
        return ok(`Matches for ${JSON.stringify(query)}:\n\n${matches.join('\n\n')} ${renderPageFooter(page.next_cursor)}`);
      }

      if (mode === 'get') {
        const id = chapterId(args.chapter_id);
        if (id == null) return err('recall_conversation: positive integer `chapter_id` is required for mode="get".');
        const row = port.get(id);
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
        if (id == null) return err('recall_conversation: positive integer `chapter_id` is required for mode="source".');
        if (!port.get(id)) return err(`Conversation chapter ${id} was not found in this session.`);
        const page = port.source(id, {
          limit: limit(args.limit, 10, MAX_SOURCE_LIMIT),
          cursor: cursor(args.cursor),
        });
        const rows = page.items.map((row) => JSON.stringify({
          id: row.id,
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
      return err(`recall_conversation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

export function buildConversationChapterTools(): CoderTool[] {
  return [recallConversationTool];
}
