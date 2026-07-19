import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronRight, Crown, X } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { parseDbDate } from '../../lib/datetime.js';
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

const LIVE_REFRESH_INTERVAL_MS = 2_000;

/**
 * Agent-run state and coder-session state do not use exactly the same status
 * vocabulary. Once the full session payload arrives it is authoritative; the
 * caller status is only the bootstrap value while that first request is in
 * flight. Waiting states are still live runs and should keep the transcript
 * fresh until the coder session reports a terminal/idle state.
 */
export function shouldPollAgentSession(
  callerStatus: string,
  sessionStatus?: string | null,
): boolean {
  const status = (sessionStatus ?? callerStatus).trim().toLowerCase();
  return status === 'active'
    || status === 'running'
    || status === 'starting'
    || status === 'pending'
    || status === 'queued'
    || status === 'resuming'
    || status.startsWith('waiting_');
}

export function AgentSessionModal({ coderSessionId, role, status, onClose }: AgentSessionModalProps) {
  const { t } = useTranslation('agents');
  const {
    data: fetchedSessionData,
    loading,
    refetch,
  } = useApi<SessionData>(`/coder/sessions/${coderSessionId}?full=1`);
  // useApi intentionally preserves the previous value while a URL changes.
  // Never render (or derive polling state from) a prior modal session during
  // that small transition window.
  const sessionData = fetchedSessionData?.session.id === coderSessionId
    ? fetchedSessionData
    : null;
  const effectiveStatus = sessionData?.session.status ?? status;
  const isLive = shouldPollAgentSession(status, sessionData?.session.status);

  useEffect(() => {
    // Recursive one-shot scheduling, gated by `loading`, means a slow request
    // must finish before the next two-second window starts. useApi cancels the
    // pending state update on unmount/session changes, while this cleanup stops
    // the next request from being initiated after the modal closes.
    if (!isLive || loading) return;
    const timer = window.setTimeout(refetch, LIVE_REFRESH_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [coderSessionId, isLive, loading, refetch]);

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
          <Badge variant="outline" className="text-[10px] capitalize">{effectiveStatus}</Badge>
          {isLive && (
            <span
              className="inline-flex items-center gap-1 text-[10px] text-emerald-400"
              title={loading ? t('common.loading') : t('company.live')}
            >
              <span className={`h-1.5 w-1.5 rounded-full bg-emerald-400 ${loading ? 'animate-pulse' : ''}`} />
              {loading ? t('common.loading') : t('company.live')}
            </span>
          )}
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

/** SQLite timestamps are UTC without a zone ("2026-04-10 17:41:22");
 *  `parseDbDate` normalizes them before rendering in the local timezone. */
function formatTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = parseDbDate(ts);
  return d ? d.toLocaleTimeString() : ts.slice(11, 19);
}
