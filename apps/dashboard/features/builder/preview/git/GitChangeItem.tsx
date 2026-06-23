import React, { useState } from 'react';
import { ChevronRight, ChevronDown, Loader2, Plus, Minus, Undo2 } from 'lucide-react';
import { workspaceApi, type GitFileStatus } from '../api.js';
import { DiffBlock } from './DiffBlock.js';
import { ConfirmDiscardDialog } from './ConfirmDiscardDialog.js';

interface Props {
  sessionId: number;
  projectId: number;
  file: GitFileStatus;
  staged: boolean;
  onMutated: () => void | Promise<void>;
}

const STATUS_COLOR: Record<string, string> = {
  M: 'text-amber-500',
  A: 'text-emerald-500',
  D: 'text-red-500',
  '?': 'text-muted-foreground',
  R: 'text-blue-500',
  C: 'text-blue-500',
};

function statusChar(file: GitFileStatus, staged: boolean): string {
  const c = staged ? file.index : file.worktree;
  return c === '.' || c === ' ' ? '·' : c;
}

export function GitChangeItem({ sessionId, projectId, file, staged, onMutated }: Props) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [discardBusy, setDiscardBusy] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && diff == null && file.index !== '?') {
      setLoading(true);
      setError(null);
      try {
        const r = await workspaceApi.gitDiff(sessionId, projectId, file.path, staged);
        setDiff(r.diff || '');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }
  }

  async function handleStageToggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (mutating) return;
    setMutating(true);
    setError(null);
    try {
      if (staged) {
        await workspaceApi.gitReset(sessionId, projectId, [file.path]);
      } else {
        await workspaceApi.gitAdd(sessionId, projectId, [file.path]);
      }
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutating(false);
    }
  }

  function openDiscardDialog(e: React.MouseEvent) {
    e.stopPropagation();
    setDiscardError(null);
    setConfirmOpen(true);
  }

  async function confirmDiscard() {
    setDiscardBusy(true);
    setDiscardError(null);
    try {
      await workspaceApi.gitDiscard(sessionId, projectId, [file.path]);
      await onMutated();
      setConfirmOpen(false);
    } catch (err) {
      setDiscardError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscardBusy(false);
    }
  }

  const ch = statusChar(file, staged);
  const color = STATUS_COLOR[ch] ?? 'text-foreground';

  return (
    <div className="border-b last:border-b-0">
      <div className="w-full flex items-center gap-1.5 px-2 py-1 text-xs hover:bg-muted/50">
        <button
          type="button"
          onClick={handleStageToggle}
          disabled={mutating}
          className="p-0.5 rounded hover:bg-muted disabled:opacity-40 shrink-0"
          title={staged ? 'Unstage' : 'Stage'}
        >
          {mutating ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : staged ? (
            <Minus className="h-3 w-3" />
          ) : (
            <Plus className="h-3 w-3" />
          )}
        </button>
        <button
          type="button"
          onClick={openDiscardDialog}
          className="p-0.5 rounded hover:bg-destructive/15 text-muted-foreground hover:text-destructive shrink-0"
          title="Descartar mudanças"
        >
          <Undo2 className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-1.5 flex-1 text-left min-w-0"
        >
          {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          <span className={`font-mono w-4 shrink-0 ${color}`}>{ch}</span>
          <span className="font-mono truncate flex-1">{file.path}</span>
        </button>
      </div>
      {open && (
        <div className="bg-muted/30">
          {loading && <div className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" /> Carregando diff…</div>}
          {error && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}
          {file.index === '?' && !loading && (
            <div className="px-3 py-2 text-xs text-muted-foreground italic">Arquivo não rastreado — sem diff.</div>
          )}
          {diff != null && !loading && <DiffBlock diff={diff} />}
        </div>
      )}
      {confirmOpen && (
        <ConfirmDiscardDialog
          title="Descartar mudanças"
          message={
            <>
              Descartar todas as mudanças em{' '}
              <span className="font-mono text-foreground">{file.path}</span>?
            </>
          }
          busy={discardBusy}
          error={discardError}
          onConfirm={confirmDiscard}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}
