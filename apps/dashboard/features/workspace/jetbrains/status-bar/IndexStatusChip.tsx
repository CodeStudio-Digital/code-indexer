/**
 * IntelliJ-style index indicator for the StatusBar: dumb mode → smart mode.
 * Live via useIndexStatus (initial frame + per-transition frames). The chip
 * is read-only; the tooltip explains the phase and what still works.
 */
import { AlertTriangle, Database, Loader2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip.js';
import { cn } from '../../../../lib/utils.js';
import type { ProjectIndexStatus } from './useIndexStatus.js';

function compact(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();
}

function chipFor(s: ProjectIndexStatus): { label: string; tone: string; busy: boolean; warn?: boolean } {
  switch (s.phase) {
    case 'scanning':
      return { label: 'Scanning…', tone: 'text-sky-400', busy: true };
    case 'structural_indexing': {
      const p = s.progress;
      return {
        label: p ? `Indexing ${compact(p.current)}/${compact(p.total)}` : 'Indexing…',
        tone: 'text-sky-400',
        busy: true,
      };
    }
    case 'semantic_indexing':
      return { label: 'Semantic indexing…', tone: 'text-violet-400', busy: true };
    case 'structural_ready':
      return { label: 'Symbols ready', tone: 'text-emerald-500/90', busy: false };
    case 'semantic_ready':
      return s.semanticStaleCount > 0
        ? { label: `Index ready (${compact(s.semanticStaleCount)} stale)`, tone: 'text-emerald-500/90', busy: false }
        : { label: 'Index ready', tone: 'text-emerald-500/90', busy: false };
    case 'too_large':
      return { label: 'Index: project too large', tone: 'text-amber-500/90', busy: false, warn: true };
    case 'error':
      return { label: 'Index error', tone: 'text-red-400', busy: false, warn: true };
    default:
      return { label: 'No index', tone: 'text-muted-foreground', busy: false };
  }
}

/**
 * Presentational — the StatusBar owns the single useIndexStatus subscription
 * and shares the same live frame with its file/symbol counters (the original
 * one-shot stats fetch froze at the page-load values, which is how the bug
 * "Symbols ready · 0 files" happened: live chip + stale counters).
 */
export function IndexStatusChip({ status }: { status: ProjectIndexStatus | null }) {
  if (!status) return null;
  const chip = chipFor(status);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex items-center gap-1 cursor-default', chip.tone)}>
          {chip.busy ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : chip.warn ? (
            <AlertTriangle className="h-2.5 w-2.5" />
          ) : (
            <Database className="h-2.5 w-2.5" />
          )}
          <span className="truncate max-w-[200px]">{chip.label}</span>
          {status.dirtyPending > 0 && <span className="text-sky-400">●{compact(status.dirtyPending)}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[300px]">
        <div className="text-[11px] leading-snug space-y-0.5">
          {status.phase === 'structural_ready' && (
            <div>
              Symbols, references and text search are live (tree-sitter, $0).
              {status.semanticStaleCount > 0
                ? ` Semantic layer (summaries/embeddings) pending for ${status.semanticStaleCount.toLocaleString()} file(s) — run a full index for semantic search.`
                : ' Run a full index to add semantic search.'}
            </div>
          )}
          {status.phase === 'semantic_ready' && (
            <div>
              Full index ready.
              {status.semanticStaleCount > 0
                ? ` ${status.semanticStaleCount.toLocaleString()} file(s) changed since the last semantic pass — symbols stay current; re-index to refresh summaries/embeddings.`
                : ' Symbols + semantic search current.'}
            </div>
          )}
          {status.phase === 'too_large' && (
            <div>Auto-index skipped (above the file cap in Settings → MCP & workers). Index manually from the Runs tab.</div>
          )}
          {status.phase === 'error' && <div>{status.error ?? 'Indexing failed — reopen the project to retry.'}</div>}
          {(status.phase === 'scanning' || status.phase === 'structural_indexing') && (
            <div>Building the structural index (symbols + word index). Search improves as it completes.</div>
          )}
          {status.phase === 'semantic_indexing' && <div>Full index running (LLM summaries + embeddings).</div>}
          {status.phase === 'none' && <div>No index yet — it builds automatically when the project opens.</div>}
          <div className="text-muted-foreground/70 pt-1">
            {status.watcherActive ? 'Watching files — edits index live.' : 'File watcher off.'}
            {status.dirtyPending > 0 ? ` ${status.dirtyPending} change(s) queued.` : ''}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
