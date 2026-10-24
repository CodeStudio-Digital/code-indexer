import { parseDbDate } from '../../../lib/datetime.js';
import type { ContentBlock, ConversationChapter, ConversationChapterContent, ConversationChapterSourceMessage, ConversationResumeContent } from '../types.js';

export const SOURCE_PAGE_SIZE = 40;

export function safeJson<T extends object>(value: string | T | null | undefined): T | null {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as T : null;
  } catch {
    return null;
  }
}

export function formatChapterDate(value: string, formatter: Intl.DateTimeFormat): string {
  const date = parseDbDate(value);
  return date ? formatter.format(date) : '';
}

export function resolvedChapterKind(
  chapter: ConversationChapter,
): NonNullable<ConversationChapter['chapter_kind']> {
  if (chapter.chapter_kind) return chapter.chapter_kind;
  if (chapter.source === 'rebuild' || chapter.source === 'legacy') return 'rebuild';
  return chapter.trigger?.startsWith('milestone:') ? 'milestone' : 'context';
}

export function chapterPreviewText(chapter: ConversationChapter): string {
  const parsed = safeJson<ConversationChapterContent>(chapter.chapter_json);
  const resume = safeJson<ConversationResumeContent>(chapter.resume_json);
  return [
    parsed?.summary,
    chapter.chapter_text,
    parsed?.work_completed?.[0],
    parsed?.decisions?.[0],
    resume?.current_focus,
    resume?.next_step,
  ].find((value) => typeof value === 'string' && value.trim().length > 0)?.trim() ?? '';
}

function contentBlocksText(blocks: ContentBlock[]): string {
  return blocks.map((block) => {
    if (block.type === 'text') return block.text ?? '';
    if (block.type === 'tool_use') return `[${block.name ?? 'tool'}]`;
    if (block.type === 'tool_result') return block.content ?? '';
    return `[${block.type}]`;
  }).filter(Boolean).join('\n');
}

export function sourceMessageText(message: ConversationChapterSourceMessage): string {
  if (Array.isArray(message.content)) return contentBlocksText(message.content);
  if (typeof message.content === 'string') {
    const parsed = safeJson<{ blocks?: ContentBlock[] }>(message.content);
    if (parsed?.blocks && Array.isArray(parsed.blocks)) return contentBlocksText(parsed.blocks);
    const parsedArray = (() => {
      try { return JSON.parse(message.content as string) as unknown; } catch { return null; }
    })();
    if (Array.isArray(parsedArray)) return contentBlocksText(parsedArray as ContentBlock[]);
    return message.content;
  }
  if (message.content_json) {
    try {
      const parsed = JSON.parse(message.content_json) as unknown;
      if (Array.isArray(parsed)) return contentBlocksText(parsed as ContentBlock[]);
    } catch { /* malformed legacy row: show an empty preview */ }
  }
  return '';
}

export function DetailSection({ label, values }: { label: string; values?: string[] }) {
  if (!values?.length) return null;
  return (
    <section className="space-y-1.5">
      <h4 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        <span className="h-px w-3 bg-primary/60" />
        {label}
      </h4>
      <ul className="space-y-1.5 text-xs leading-relaxed text-foreground/80">
        {values.map((value, index) => (
          <li key={`${index}-${value}`} className="grid grid-cols-[6px_1fr] gap-2 break-words">
            <span className="mt-[7px] h-1 w-1 rounded-full bg-primary/70" />
            <span>{value}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
