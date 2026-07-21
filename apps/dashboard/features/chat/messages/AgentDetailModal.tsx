import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Check, Loader2, X } from 'lucide-react';
import type { ParallelAgent } from '../../../hooks/useAgentStream.js';
import { Badge } from '../../../components/ui/badge.js';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.js';
import { cn } from '../../../lib/utils.js';
import { Markdown } from './Markdown.js';
import { parsePersistedAgentsGroup } from './agents-group-parser.js';
import type { AgentsGroupResultSource } from './AgentsGroupBlock.js';

interface AgentDetailModalProps {
  agent: ParallelAgent;
  resultSource?: AgentsGroupResultSource;
  /** P1: enables the retained-transcript fetch (worker realm, ~45min TTL). */
  transcriptSource?: { sessionId: number; groupId: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * After-the-fact detail for a single spawned agent: its task (prompt), final
 * report, metrics — and, while the retention window lasts, the step-by-step
 * TRANSCRIPT digest kept by the resume registry (P1 of the ultra-agent
 * parity plan): every tool call with inputs and result excerpts.
 */
export function AgentDetailModal({ agent, resultSource, transcriptSource, open, onOpenChange }: AgentDetailModalProps) {
  const { t } = useTranslation('chat');
  const [fullAgent, setFullAgent] = useState<ParallelAgent | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);

  useEffect(() => {
    setFullAgent(null);
    setLoadingFull(false);
    setFullError(null);
    setTranscript(null);
    setLoadingTranscript(false);
    setTranscriptError(null);
  }, [agent.index, resultSource?.toolUseId, open]);

  const loadTranscript = async () => {
    if (!transcriptSource) return;
    setLoadingTranscript(true);
    setTranscriptError(null);
    try {
      const params = new URLSearchParams({
        spawn_id: transcriptSource.groupId,
        agent: String(agent.index + 1),
      });
      const r = await fetch(
        `/api/coder/sessions/${transcriptSource.sessionId}/agents/transcript?${params.toString()}`,
      );
      const data = (await r.json().catch(() => null)) as
        { ok?: boolean; text?: string; hasTranscript?: boolean; reason?: string } | null;
      if (!r.ok || !data?.ok) {
        throw new Error(data?.reason ?? `HTTP ${r.status}`);
      }
      setTranscript(data.text ?? '');
    } catch (err) {
      console.warn('[agent-detail] failed to load transcript', err);
      setTranscriptError(t('agentGroup.transcriptError', {
        defaultValue: 'Transcript indisponível — a retenção dura ~45min e não sobrevive a restarts.',
      }));
    } finally {
      setLoadingTranscript(false);
    }
  };

  const displayAgent = fullAgent ?? agent;
  const isError = !!displayAgent.error;
  const tokens = displayAgent.usage ? displayAgent.usage.input_tokens + displayAgent.usage.output_tokens : null;
  const providerLabel =
    displayAgent.provider && displayAgent.model
      ? `${displayAgent.provider}:${displayAgent.model}`
      : displayAgent.provider ?? displayAgent.model ?? null;
  const canLoadFull =
    !fullAgent &&
    !loadingFull &&
    !!resultSource?.isTruncated &&
    !!resultSource.input &&
    !!resultSource.sessionId &&
    !!resultSource.toolUseId;

  const loadFullReport = async () => {
    if (!resultSource?.input || !resultSource.sessionId || !resultSource.toolUseId) return;
    setLoadingFull(true);
    setFullError(null);
    try {
      const r = await fetch(
        `/api/coder/sessions/${resultSource.sessionId}/tool-results/${encodeURIComponent(resultSource.toolUseId)}/full`,
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { content?: string; is_error?: boolean };
      const group = parsePersistedAgentsGroup(resultSource.input, {
        content: data.content ?? '',
        isError: Boolean(data.is_error),
      });
      const next = group?.agents.find((a) => a.index === agent.index);
      if (!next) throw new Error('agent not found in full result');
      setFullAgent(next);
    } catch (err) {
      console.warn('[agent-detail] failed to load full report', err);
      setFullError(t('agentGroup.showMoreError', { defaultValue: 'Could not load the full report.' }));
    } finally {
      setLoadingFull(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <div
              className={cn(
                'h-5 w-5 rounded-md flex items-center justify-center shrink-0',
                isError ? 'text-destructive bg-destructive/10' : 'text-success bg-success/10',
              )}
            >
              {isError ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}
            </div>
            <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="font-mono truncate">{displayAgent.label}</span>
          </DialogTitle>
        </DialogHeader>

        {/* Meta badges */}
        <div className="flex flex-wrap items-center gap-1.5 -mt-1">
          {displayAgent.agentType && <Badge variant="outline" className="text-[10px]">{displayAgent.agentType}</Badge>}
          {displayAgent.attempt != null && displayAgent.attempt >= 2 && (
            <Badge variant="outline" className="text-[10px] border-warning/50 text-warning">retry #{displayAgent.attempt}</Badge>
          )}
          {displayAgent.reason && displayAgent.reason !== 'completed' && (
            <Badge variant="outline" className="text-[10px] border-destructive/40 text-destructive">{displayAgent.reason}</Badge>
          )}
          {providerLabel && (
            <Badge variant="secondary" className="text-[10px] max-w-[240px] truncate" title={providerLabel}>
              {providerLabel}
            </Badge>
          )}
          <Badge variant="outline" className="text-[10px] tabular-nums">
            {displayAgent.toolCallCount} tool{displayAgent.toolCallCount !== 1 ? 's' : ''}
          </Badge>
          {tokens !== null && (
            <Badge variant="outline" className="text-[10px] tabular-nums">{tokens.toLocaleString()} tokens</Badge>
          )}
        </div>

        {/* Task (the prompt the agent received) */}
        {displayAgent.task && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              {t('agentGroup.task', { defaultValue: 'Task' })}
            </div>
            <div className="text-xs text-foreground/80 whitespace-pre-wrap rounded-md border bg-muted/30 p-2 max-h-48 overflow-y-auto">
              {displayAgent.task}
            </div>
          </div>
        )}

        {/* Report / error */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            {isError
              ? t('agentGroup.error', { defaultValue: 'Error' })
              : t('agentGroup.report', { defaultValue: 'Report' })}
          </div>
          {isError ? (
            <pre className="font-mono text-[11px] text-destructive whitespace-pre-wrap break-all rounded-md border border-destructive/40 p-2">
              {displayAgent.error}
            </pre>
          ) : displayAgent.summary ? (
            <div className="text-sm text-foreground/90">
              <Markdown text={displayAgent.summary} />
            </div>
          ) : (
            <div className="text-xs text-muted-foreground italic">
              {t('agentGroup.noReport', { defaultValue: 'No report produced.' })}
            </div>
          )}
          {(canLoadFull || loadingFull) && (
            <button
              type="button"
              onClick={loadFullReport}
              disabled={loadingFull}
              className="mt-2 inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-70"
            >
              {loadingFull && <Loader2 className="h-3 w-3 animate-spin" />}
              {loadingFull
                ? t('agentGroup.loadingMore', { defaultValue: 'Loading...' })
                : t('agentGroup.showMore', { defaultValue: 'Show more' })}
            </button>
          )}
          {fullError && (
            <div className="mt-2 text-xs text-destructive">
              {fullError}
            </div>
          )}
        </div>

        {/* Retained transcript digest (P1) */}
        {transcriptSource && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              {t('agentGroup.transcript', { defaultValue: 'Transcript' })}
            </div>
            {transcript !== null ? (
              <pre className="font-mono text-[11px] text-foreground/80 whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 max-h-72 overflow-y-auto">
                {transcript || t('agentGroup.transcriptEmpty', { defaultValue: '(vazio)' })}
              </pre>
            ) : (
              <button
                type="button"
                onClick={loadTranscript}
                disabled={loadingTranscript}
                className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted disabled:cursor-wait disabled:opacity-70"
              >
                {loadingTranscript && <Loader2 className="h-3 w-3 animate-spin" />}
                {loadingTranscript
                  ? t('agentGroup.loadingMore', { defaultValue: 'Loading...' })
                  : t('agentGroup.showTranscript', { defaultValue: 'Ver passo-a-passo (tools + resultados)' })}
              </button>
            )}
            {transcriptError && (
              <div className="mt-2 text-xs text-muted-foreground">{transcriptError}</div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
