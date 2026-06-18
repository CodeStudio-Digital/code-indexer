/**
 * Diálogo do Local History (estilo JetBrains): lista de revisões à esquerda,
 * diff (revisão vs. disco atual) + ações Restaurar/Rotular à direita. Modal e
 * global; aberto via state/local-history-store.
 */
import { useMemo } from 'react';
import { History, RotateCcw, Tag } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { Dialog, DialogContent, DialogTitle } from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import { confirm, prompt } from '../../../components/ui/prompt-dialog.js';
import { useLocalHistory } from '../../../state/local-history-store.js';
import { RevisionRow } from './RevisionRow.js';
import { useHistoryData } from './useHistoryData.js';
import { lineDiff, diffStat } from './line-diff.js';

function basename(p: string): string {
  const ix = p.lastIndexOf('/');
  return ix < 0 ? p : p.slice(ix + 1);
}

export function LocalHistoryDialog() {
  const target = useLocalHistory((s) => s.target);
  const close = useLocalHistory((s) => s.close);
  if (!target) return null;
  return <Inner key={`${target.projectId}:${target.path}`} projectId={target.projectId} path={target.path} onClose={close} />;
}

function Inner({ projectId, path, onClose }: { projectId: number; path: string; onClose: () => void }) {
  const d = useHistoryData(projectId, path);

  const diff = useMemo(
    () => (d.oldContent == null ? [] : lineDiff(d.oldContent, d.currentContent)),
    [d.oldContent, d.currentContent],
  );
  const stat = useMemo(() => diffStat(diff), [diff]);

  const onRestore = async () => {
    if (d.selectedId == null) return;
    const ok = await confirm({
      title: 'Restore this version?',
      description: 'The current on-disk content is snapshotted first, so this is reversible.',
      confirmLabel: 'Restore',
    });
    if (ok) void d.restore(d.selectedId);
  };
  const onLabel = async () => {
    if (d.selectedId == null) return;
    const value = await prompt({ title: 'Label revision', placeholder: 'e.g. before refactor', confirmLabel: 'Save' });
    if (value) void d.label(d.selectedId, value);
  };

  const canRestore = d.selected != null && d.selected.oversized === 0 && !d.busy;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-5xl w-[min(94vw,1040px)] p-0 gap-0 overflow-hidden">
        <div className="h-11 shrink-0 border-b flex items-center gap-2 px-4">
          <History className="h-4 w-4 text-primary" />
          <DialogTitle className="text-[13px] font-semibold truncate">Local History — {basename(path)}</DialogTitle>
          <div className="ml-auto flex items-center gap-1.5 pr-8">
            <Button variant="ghost" size="sm" className="h-7 gap-1.5" onClick={() => void onLabel()} disabled={d.selectedId == null}>
              <Tag className="h-3.5 w-3.5" /> Label
            </Button>
            <Button size="sm" className="h-7 gap-1.5" onClick={() => void onRestore()} disabled={!canRestore}>
              <RotateCcw className="h-3.5 w-3.5" /> Restore
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 h-[70vh]">
          <div className="w-64 shrink-0 border-r overflow-y-auto">
            {d.revisions.length === 0 ? (
              <div className="text-[11.5px] text-muted-foreground px-3 py-4 text-center">No history yet — edit and save this file to start recording versions.</div>
            ) : (
              d.revisions.map((rev) => (
                <RevisionRow key={rev.id} rev={rev} selected={rev.id === d.selectedId} onSelect={d.setSelectedId} />
              ))
            )}
          </div>

          <div className="flex-1 min-w-0 flex flex-col">
            <div className="h-7 shrink-0 border-b flex items-center gap-3 px-3 text-[11px] text-muted-foreground">
              <span>Selected version ↔ current</span>
              {diff.length > 0 && (
                <span className="ml-auto font-mono">
                  <span className="text-emerald-400">+{stat.added}</span> <span className="text-rose-400">−{stat.removed}</span>
                </span>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-auto font-mono text-[11.5px] leading-[1.5]">
              {d.selected?.oversized === 1 ? (
                <Placeholder text="Preview unavailable — binary or oversized revision." />
              ) : d.selected?.existed_before === 0 ? (
                <Placeholder text="In this version the file did not exist. Restoring deletes it." />
              ) : d.loading ? (
                <Placeholder text="Loading…" />
              ) : diff.length === 0 ? (
                <Placeholder text="This version is identical to the current file." />
              ) : (
                diff.map((l, idx) => (
                  <div
                    key={idx}
                    className={cn(
                      'px-2 whitespace-pre-wrap break-all',
                      l.type === 'add' && 'bg-emerald-500/10 text-emerald-300',
                      l.type === 'del' && 'bg-rose-500/10 text-rose-300',
                      l.type === 'ctx' && 'text-muted-foreground',
                    )}
                  >
                    <span className="select-none opacity-40 mr-2 inline-block w-2">
                      {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}
                    </span>
                    {l.text || ' '}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Placeholder({ text }: { text: string }) {
  return <div className="h-full grid place-items-center text-muted-foreground text-[12px] px-6 text-center">{text}</div>;
}
