import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { useApi } from '../../hooks/useApi.js';
import { copyText } from '../../lib/clipboard.js';
import { cn, formatRelativeTime } from '../../lib/utils.js';
import { formatDuration } from './utils.js';
import { promptCacheHitRatio, promptInputTokens } from './prompt-cache-metrics.js';

type SessionInputKind =
  | 'system_prompt'
  | 'skill_content'
  | 'system_reminder'
  | 'subagent_prompt'
  | 'tools_snapshot'
  | 'phase_route_skip_summary'
  | 'preflight';

interface SessionInputRow {
  id: number;
  session_id: number;
  kind: SessionInputKind;
  source_label: string;
  content: string;
  content_hash: string;
  meta_json: string | null;
  created_at: string;
}

const INPUT_KIND_STYLES: Record<SessionInputKind, string> = {
  system_prompt: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  skill_content: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  system_reminder: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  subagent_prompt: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  tools_snapshot: 'bg-pink-500/15 text-pink-600 dark:text-pink-400',
  phase_route_skip_summary: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  preflight: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400',
};

export interface SessionStatsLike {
  message_count: number;
  assistant_turns: number;
  tool_call_count: number;
  tool_error_count: number;
  distinct_tools: number;
  subagent_call_count: number;
  total_tool_duration_ms: number;
  duration_ms: number;
  last_turn_input_tokens?: number;
  context_window?: number | null;
}

export interface SessionLike {
  provider?: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens?: number;
  total_cache_creation_tokens?: number;
  last_turn_input_tokens?: number;
}

interface SessionDetailsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: number | null;
  session: SessionLike | null;
  stats: SessionStatsLike | null;
}

function useSessionInputs(sessionId: number | null, active: boolean) {
  const inputsUrl = active && sessionId ? `/coder/sessions/${sessionId}/inputs` : '';
  return useApi<SessionInputRow[]>(inputsUrl);
}

/**
 * Headless body of the session-details surface. Reused by the legacy
 * modal AND the right-rail `details` panel. `active` gates the fetches
 * when the panel is collapsed. Plans moved to their own rail panel;
 * this keeps Summary + Inputs.
 */
export function SessionDetailsView({
  sessionId,
  session,
  stats,
  active,
}: {
  sessionId: number | null;
  session: SessionLike | null;
  stats: SessionStatsLike | null;
  active: boolean;
}) {
  const { t } = useTranslation(['chat', 'common']);
  const { data: inputs, loading: inputsLoading } = useSessionInputs(sessionId, active);
  return (
    <Tabs defaultValue="summary" className="flex-1 flex flex-col min-h-0">
      {/* Compact tab strip tuned for the right-rail width: smaller text,
          shorter row, no icons (the labels are short enough to read).
          `overflow-x-auto` still keeps the row scrollable on very narrow
          panels. `bg-transparent` + `rounded-none` + bottom border match
          the chrome of the parent `PanelChrome`. */}
      <TabsList className="w-full justify-start overflow-x-auto shrink-0 h-8 rounded-none border-b bg-transparent px-2 gap-0.5">
        <TabsTrigger value="summary" className="h-7 px-2 text-[11px]">
          {t('chat:details.summary')}
        </TabsTrigger>
        <TabsTrigger value="inputs" className="h-7 px-2 text-[11px] gap-1">
          {t('chat:details.inputs')}
          {inputs && inputs.length > 0 && (
            <Badge variant="muted" className="h-3.5 text-[9px] px-1">
              {inputs.length}
            </Badge>
          )}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="summary" className="flex-1 overflow-y-auto mt-0 px-3 py-3">
        {session ? (
          <SessionSummaryView session={session} stats={stats} />
        ) : (
          <div className="text-xs text-muted-foreground">{t('chat:details.noData')}</div>
        )}
      </TabsContent>

      <TabsContent value="inputs" className="flex-1 overflow-y-auto mt-0 px-3 py-3">
        <SessionInputsContent inputs={inputs} loading={inputsLoading} />
      </TabsContent>
    </Tabs>
  );
}

export function SessionDetailsModal({
  open,
  onOpenChange,
  sessionId,
  session,
  stats,
}: SessionDetailsModalProps) {
  const { t } = useTranslation(['chat']);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('chat:details.title')}</DialogTitle>
        </DialogHeader>
        <SessionDetailsView
          sessionId={sessionId}
          session={session}
          stats={stats}
          active={open}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Format token counts compactly (e.g. 180k, 1.2M). */
function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function SessionSummaryView({ session, stats }: { session: SessionLike; stats: SessionStatsLike | null }) {
  const { t } = useTranslation('chat');
  const totalIn = session.total_input_tokens;
  const totalOut = session.total_output_tokens;
  const totalCR = session.total_cache_read_tokens ?? 0;
  const totalCW = session.total_cache_creation_tokens ?? 0;
  const usage = {
    provider: session.provider,
    inputTokens: totalIn,
    cacheReadTokens: totalCR,
    cacheCreationTokens: totalCW,
  };
  const promptInput = promptInputTokens(usage);
  const hitRate = Math.round((promptCacheHitRatio(usage) ?? 0) * 100);
  const savedTokens = Math.round(totalCR * 0.5);

  const lastTurnInput = session.last_turn_input_tokens ?? stats?.last_turn_input_tokens ?? 0;
  const contextWindow = stats?.context_window ?? null;
  const ctxPct = contextWindow && lastTurnInput > 0
    ? Math.min(Math.round((lastTurnInput / contextWindow) * 100), 100)
    : null;

  // `text-xs` + `gap-x-3` keeps the two-column key/value rows readable
  // when the panel is at minSize (≈220px). The labels are left-aligned
  // with `truncate` so very long i18n strings don't push the numeric
  // value off-screen — they just get a tooltip-equivalent via title.
  return (
    <div className="space-y-4 text-xs">
      {ctxPct !== null && contextWindow && (
        <section>
          <SectionTitle>{t('header.contextWindow')}</SectionTitle>
          <KvGrid>
            <Kv label={t('header.currentContext')}>
              {lastTurnInput.toLocaleString()} <span className="text-muted-foreground">({formatK(lastTurnInput)})</span>
            </Kv>
            <Kv label={t('header.windowSize')}>
              {contextWindow.toLocaleString()} <span className="text-muted-foreground">({formatK(contextWindow)})</span>
            </Kv>
            <Kv
              label={t('header.contextUsage')}
              valueClassName={cn(
                'font-medium',
                ctxPct > 90 ? 'text-red-500' : ctxPct > 70 ? 'text-amber-500' : 'text-emerald-600 dark:text-emerald-400',
              )}
            >
              {ctxPct}%
            </Kv>
          </KvGrid>
          <div className="mt-2 w-full h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                ctxPct > 90 ? 'bg-red-500' : ctxPct > 70 ? 'bg-amber-500' : 'bg-emerald-500',
              )}
              style={{ width: `${ctxPct}%` }}
            />
          </div>
        </section>
      )}

      <section>
        <SectionTitle>{t('header.apiTotals')}</SectionTitle>
        <KvGrid>
            <Kv label={t('header.totalInput')}>{promptInput.toLocaleString()}</Kv>
          <Kv label={t('header.output')}>{totalOut.toLocaleString()}</Kv>
          <Kv label={t('header.cacheRead')} valueClassName="text-emerald-600 dark:text-emerald-400">
            {totalCR.toLocaleString()}
          </Kv>
          <Kv label={t('header.cacheWrite')}>{totalCW.toLocaleString()}</Kv>
          <Kv label={t('header.hitRate')} valueClassName="text-emerald-600 dark:text-emerald-400">
            {hitRate}%
          </Kv>
          <Kv label={t('header.tokensSaved')} valueClassName="text-emerald-600 dark:text-emerald-400">
            {savedTokens.toLocaleString()}
          </Kv>
        </KvGrid>
      </section>

      {stats && (
        <section>
          <SectionTitle>Atividade</SectionTitle>
          <KvGrid>
            <Kv label={t('header.messages')}>{stats.message_count}</Kv>
            <Kv label={t('header.assistantTurns')}>{stats.assistant_turns}</Kv>
            <Kv label={t('header.toolCalls')}>{stats.tool_call_count}</Kv>
            <Kv label={t('header.distinctTools')}>{stats.distinct_tools}</Kv>
            {stats.tool_error_count > 0 && (
              <Kv label={t('header.toolErrors')} valueClassName="text-red-500">
                {stats.tool_error_count}
              </Kv>
            )}
            {stats.subagent_call_count > 0 && (
              <Kv label={t('header.subagents')}>{stats.subagent_call_count}</Kv>
            )}
            <Kv label={t('header.timeInTools')}>{(stats.total_tool_duration_ms / 1000).toFixed(1)}s</Kv>
            <Kv label={t('header.duration')}>{formatDuration(stats.duration_ms)}</Kv>
          </KvGrid>
        </section>
      )}
    </div>
  );
}

/** Captured model inputs as a standalone surface for the unified Insights panel. */
export function SessionInputsView({
  sessionId,
  active,
}: {
  sessionId: number | null;
  active: boolean;
}) {
  const { data: inputs, loading } = useSessionInputs(sessionId, active);
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
      <SessionInputsContent inputs={inputs} loading={loading} />
    </div>
  );
}

function SessionInputsContent({
  inputs,
  loading,
}: {
  inputs: SessionInputRow[] | null | undefined;
  loading: boolean;
}) {
  const { t } = useTranslation(['chat', 'common']);
  return (
    <>
      {loading && <div className="text-xs text-muted-foreground">{t('common:actions.loading')}</div>}
      {!loading && (!inputs || inputs.length === 0) && (
        <div className="text-xs text-muted-foreground py-8 text-center">
          {t('chat:details.noInputs')}
        </div>
      )}
      <div className="space-y-2">
        {inputs?.map((entry) => <InputItem key={entry.id} entry={entry} />)}
      </div>
    </>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
      {children}
    </h4>
  );
}

function KvGrid({ children }: { children: React.ReactNode }) {
  return <div className="space-y-0.5 tabular-nums">{children}</div>;
}

function Kv({
  label,
  valueClassName,
  children,
}: {
  label: string;
  valueClassName?: string;
  children: React.ReactNode;
}) {
  // Single-row layout: label on the left, value pushed right via
  // `ml-auto`. Doesn't rely on a fixed grid so very-long labels don't
  // squeeze the numeric column — instead the label truncates with a
  // tooltip-equivalent `title` so the user can still recover the full
  // string by hovering.
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="text-muted-foreground truncate min-w-0" title={label}>
        {label}
      </span>
      <span className={cn('ml-auto text-right shrink-0', valueClassName)}>{children}</span>
    </div>
  );
}

/**
 * Split a system-prompt-like body into collapsible markdown sections by H1
 * (`# `) and H2 (`## `) headings. Returns sections in document order; the
 * first section may be untitled (text before the first heading).
 */
function splitInputSections(content: string): Array<{ title: string | null; body: string }> {
  const lines = content.split('\n');
  const sections: Array<{ title: string | null; body: string[] }> = [{ title: null, body: [] }];
  for (const line of lines) {
    const m = /^(#{1,2})\s+(.+)$/.exec(line);
    if (m) {
      sections.push({ title: m[2].trim(), body: [] });
    } else {
      sections[sections.length - 1].body.push(line);
    }
  }
  return sections
    .map((s) => ({ title: s.title, body: s.body.join('\n').trim() }))
    .filter((s) => s.title !== null || s.body.length > 0);
}

function InputSection({ title, body, defaultOpen }: { title: string | null; body: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (title === null) {
    return body ? (
      <pre className="text-[11px] whitespace-pre-wrap break-words font-mono bg-muted/30 rounded px-2 py-1.5 my-1">
        {body}
      </pre>
    ) : null;
  }
  return (
    <div className="border-t first:border-t-0 mt-1.5 pt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 text-left text-[11px] font-semibold hover:text-foreground/80"
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span className="truncate">{title}</span>
      </button>
      {open && body && (
        <pre className="text-[11px] whitespace-pre-wrap break-words font-mono bg-muted/30 rounded px-2 py-1.5 mt-1">
          {body}
        </pre>
      )}
    </div>
  );
}

function InputItem({ entry }: { entry: SessionInputRow }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (await copyText(entry.content)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const sections = splitInputSections(entry.content);
  const previewSource = sections.find((s) => s.title)?.title ?? entry.content.split('\n').find((l) => l.trim()) ?? '';

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span
              className={cn(
                'text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded',
                INPUT_KIND_STYLES[entry.kind],
              )}
            >
              {t(`details.inputKind.${entry.kind}`)}
            </span>
            <span className="text-[11px] font-mono text-muted-foreground truncate">{entry.source_label}</span>
            <span className="text-[11px] text-muted-foreground">{formatRelativeTime(entry.created_at)}</span>
          </div>
          {!open && previewSource && (
            <div className="text-xs text-foreground/80 truncate">{previewSource}</div>
          )}
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3 border-t bg-muted/20">
          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={onCopy}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5 hover:bg-muted"
              aria-label="Copy raw input"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? t('details.copiedInput') : t('details.copyInput')}
            </button>
          </div>
          <div className="mt-1">
            {sections.map((s, i) => (
              <InputSection
                key={`${entry.id}-${i}`}
                title={s.title}
                body={s.body}
                defaultOpen={sections.length <= 3}
              />
            ))}
          </div>
          {entry.meta_json && <InputMeta json={entry.meta_json} />}
        </div>
      )}
    </div>
  );
}

function InputMeta({ json }: { json: string }) {
  let pretty = json;
  try {
    pretty = JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    /* keep raw */
  }
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t mt-1.5 pt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 text-left text-[11px] font-semibold text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span>meta</span>
      </button>
      {open && (
        <pre className="text-[11px] whitespace-pre-wrap break-words font-mono bg-muted/30 rounded px-2 py-1.5 mt-1">
          {pretty}
        </pre>
      )}
    </div>
  );
}
