/**
 * Conteúdo do Local History (estilo JetBrains) como surface full-height,
 * independente de container: lista de revisões à esquerda, diff (revisão vs.
 * disco atual) + ações Restaurar/Rotular à direita. Preenche o pai
 * (`h-full min-h-0`), então serve tanto à janela popout (PopoutRoot) quanto à
 * modal de fallback (LocalHistoryDialog). Aberto via openDetached / store.
 */
import { useMemo } from 'react';
import { History, RotateCcw, Tag } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { confirm, prompt } from '../../../components/ui/prompt-dialog.js';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';
import { RevisionRow } from './RevisionRow.js';
import { useHistoryData } from './useHistoryData.js';
import { lineDiff, diffStat } from './line-diff.js';
import { LazyHistoryDiff } from './LazyHistoryDiff.js';

export function basename(p: string): string {
  const ix = p.lastIndexOf('/');
  return ix < 0 ? p : p.slice(ix + 1);
}

export function LocalHistoryView({ projectId, path }: { projectId: number; path: string }) {
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
    <div className="flex flex-col h-full min-h-0">
      <div className="h-11 shrink-0 border-b flex items-center gap-2 px-4">
        <History className="h-4 w-4 text-primary" />
        <span className="text-[13px] font-semibold truncate">Local History — {basename(path)}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="sm" className="h-7 gap-1.5" onClick={() => void onLabel()} disabled={d.selectedId == null}>
            <Tag className="h-3.5 w-3.5" /> Label
          </Button>
          <Button size="sm" className="h-7 gap-1.5" onClick={() => void onRestore()} disabled={!canRestore}>
            <RotateCcw className="h-3.5 w-3.5" /> Restore
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
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
          <div className="flex-1 min-h-0">
            {d.selected?.oversized === 1 ? (
              <Placeholder text="Preview unavailable — binary or oversized revision." />
            ) : d.selected?.existed_before === 0 ? (
              <Placeholder text="In this version the file did not exist. Restoring deletes it." />
            ) : d.loading ? (
              <Placeholder text="Loading…" />
            ) : diff.length === 0 ? (
              <Placeholder text="This version is identical to the current file." />
            ) : (
              <LazyHistoryDiff original={d.oldContent ?? ''} modified={d.currentContent} language={languageIdForPath(path)} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Placeholder({ text }: { text: string }) {
  return <div className="h-full grid place-items-center text-muted-foreground text-[12px] px-6 text-center">{text}</div>;
}
