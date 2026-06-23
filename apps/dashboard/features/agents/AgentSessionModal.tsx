import React from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronRight, Crown, X } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { useApi } from '../../hooks/useApi.js';
import { Markdown } from '../chat/messages/Markdown.js';
import { SessionStateBanner } from '../chat/SessionStateBanner.js';
import type { CoderMessageRow } from '@mcp/code-agent';

interface SessionData {
  session: {
    id: number;
    title: string;
    provider: string;
    model: string;
    status: string;
    total_input_tokens: number;
    total_output_tokens: number;
  };
  /**
   * The full response from `/api/coder/sessions/:id?full=1` carries BOTH:
   *  - `messages: AgentMessage[]` — parsed objects with `content` as array
   *  - `message_rows: CoderMessageRow[]` — raw rows with `content_json: string`
   * We use `message_rows` because the modal renderer expects to parse the
   * JSON itself (and the parser unlocks rendering of `thinking` and
   * `image` blocks the backend's parsed shape would also expose, but
   * less directly). Earlier versions of this file read `messages` and
   * silently rendered every row as a dash because the parser was fed
   * an undefined `content_json`.
   */
  message_rows: CoderMessageRow[];
}

interface AgentSessionModalProps {
  coderSessionId: number;
  role: string;
  status: string;
  onClose: () => void;
}

export function AgentSessionModal({ coderSessionId, role, status, onClose }: AgentSessionModalProps) {
  const { t } = useTranslation('agents');
  const { data: sessionData } = useApi<SessionData>(`/coder/sessions/${coderSessionId}?full=1`);

  // Meta rows (`is_meta=1`) are runtime-injected nudges from the
  // orchestrator (stop-guard reminders, subordinate-completion pings,
  // etc.). Hiding them mirrors the main chat view and keeps the modal
  // focused on the agent's own conversation.
  const visibleRows = sessionData?.message_rows?.filter((r) => !r.is_meta) ?? [];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-card rounded-lg border shadow-xl w-full max-w-4xl h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b flex items-center gap-2">
          {role === 'master' ? (
            <Crown className="h-4 w-4 text-yellow-400" />
          ) : (
            <Bot className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="font-medium capitalize">{role}</span>
          {sessionData && (
            <span className="text-xs text-muted-foreground">
              {sessionData.session.provider}/{sessionData.session.model}
            </span>
          )}
          <Badge variant="outline" className="text-[10px] capitalize">{status}</Badge>
          {sessionData && (
            <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
              {formatTokens(sessionData.session.total_input_tokens)} in / {formatTokens(sessionData.session.total_output_tokens)} out
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0 ml-2">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Goal + active tasks (persisted, survives reloads) */}
        <SessionStateBanner sessionId={coderSessionId} />

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {!sessionData && (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t('common.loading', 'Loading…')}
            </p>
          )}
          {sessionData && visibleRows.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t('agentModal.noMessages', 'No messages yet for this session.')}
            </p>
          )}
          {visibleRows.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: CoderMessageRow }) {
  const blocks = parseContentBlocks(message.content_json);
  const isUser = message.role === 'user';

  return (
    <div className={`rounded-lg border p-3 text-xs ${isUser ? 'bg-primary/5 border-primary/20' : 'bg-card'}`}>
      <div className="flex items-center gap-2 mb-1.5">
        <Badge variant="outline" className="text-[9px]">{message.role}</Badge>
        <span className="text-[10px] text-muted-foreground">
          {formatTime(message.created_at)}
        </span>
        {(message.input_tokens > 0 || message.output_tokens > 0) && (
          <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
            {formatTokens(message.input_tokens + message.output_tokens)}
          </span>
        )}
      </div>
      {blocks.length === 0 ? (
        <span className="text-[10px] text-muted-foreground italic">
          (assistant turn with no rendered content — likely tool_use only)
        </span>
      ) : (
        blocks.map((block, i) => <BlockView key={i} block={block} />)
      )}
    </div>
  );
}

function BlockView({ block }: { block: ContentBlock }) {
  if (block.type === 'text' && block.text) {
    return <Markdown text={block.text} />;
  }
  if (block.type === 'thinking') {
    return <ThinkingBlock content={block.thinking ?? block.text ?? ''} />;
  }
  if (block.type === 'tool_use') {
    return (
      <div className="my-1 px-2 py-1 rounded bg-muted/50 font-mono text-[10px]">
        <span className="text-muted-foreground">tool:</span> {block.name}
        {block.input && (
          <details className="mt-0.5">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              input
            </summary>
            <pre className="mt-1 whitespace-pre-wrap break-words bg-background/60 p-1 rounded text-[10px]">
              {safeStringify(block.input)}
            </pre>
          </details>
        )}
      </div>
    );
  }
  if (block.type === 'tool_result') {
    const text = toolResultText(block);
    return (
      <div className="my-1 px-2 py-1 rounded bg-muted/30 text-[10px] max-h-32 overflow-y-auto">
        <span className="text-muted-foreground">result:</span>{' '}
        {text.length > 200 ? text.slice(0, 200) + '…' : text}
      </div>
    );
  }
  if (block.type === 'image') {
    const src =
      block.source && typeof block.source === 'object' && block.source.type === 'base64'
        ? `data:${block.source.media_type};base64,${block.source.data}`
        : null;
    if (!src) {
      return <span className="text-[10px] text-muted-foreground italic">(image — unsupported source)</span>;
    }
    return (
      <img
        src={src}
        alt="message attachment"
        className="my-1 rounded border max-h-48 max-w-full object-contain"
      />
    );
  }
  return (
    <div className="my-1 text-[10px] text-muted-foreground italic">
      (unrendered block: <span className="font-mono">{block.type}</span>)
    </div>
  );
}

/**
 * Reasoning blocks come from providers that emit a separate
 * "thinking" channel (Claude with extended thinking, OpenAI reasoning).
 * We render them collapsed by default so they don't crowd the
 * transcript — clicking the summary expands the prose.
 */
function ThinkingBlock({ content }: { content: string }) {
  if (!content.trim()) return null;
  return (
    <details className="my-1 text-[11px] opacity-70">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
        <ChevronRight className="h-3 w-3" />
        thinking
        <span className="text-[9px] text-muted-foreground">({content.length} chars)</span>
      </summary>
      <div className="mt-1 px-2 py-1 rounded bg-muted/30 italic text-muted-foreground whitespace-pre-wrap">
        {content}
      </div>
    </details>
  );
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  /** tool_use input is provider-shaped (object). */
  input?: unknown;
  /** tool_result content may be a string OR an array of typed parts. */
  content?: unknown;
  /** Extended-thinking content. */
  thinking?: string;
  /** image block source — `{ type: 'base64', media_type, data }` for Anthropic. */
  source?: { type: 'base64'; media_type: string; data: string };
}

function parseContentBlocks(json: string): ContentBlock[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) return parsed as ContentBlock[];
    if (typeof parsed === 'string') return [{ type: 'text', text: parsed }];
    return [{ type: 'text', text: json }];
  } catch {
    return [{ type: 'text', text: json }];
  }
}

/**
 * `tool_result.content` from Anthropic comes as `[{ type: 'text', text }, ...]`
 * but legacy rows stored it as a plain string. Normalize to a single
 * display string for the modal's read-only preview.
 */
function toolResultText(block: ContentBlock): string {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object' && 'text' in p && typeof (p as { text?: unknown }).text === 'string') {
          return (p as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** SQLite timestamps use space separator ("2026-04-10 17:41:22"), not ISO "T".
 *  new Date() fails in strict browsers without the T. */
function formatTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T');
  const d = new Date(iso);
  return isNaN(d.getTime()) ? ts.slice(11, 19) : d.toLocaleTimeString();
}
