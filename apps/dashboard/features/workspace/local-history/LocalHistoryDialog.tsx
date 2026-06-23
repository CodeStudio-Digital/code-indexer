/**
 * Fallback browser/dev do Local History: a mesma surface (LocalHistoryView)
 * embrulhada numa modal Radix. No desktop o trigger usa `openDetached` →
 * janela popout dedicada (PopoutRoot), então esta modal só aparece quando
 * `window.electronAPI` está ausente (build de navegador). Aberta via
 * state/local-history-store; permanece montada em ProjectView.
 */
import { Dialog, DialogContent, DialogTitle } from '../../../components/ui/dialog.js';
import { useLocalHistory } from '../../../state/local-history-store.js';
import { LocalHistoryView, basename } from './LocalHistoryView.js';

export function LocalHistoryDialog() {
  const target = useLocalHistory((s) => s.target);
  const close = useLocalHistory((s) => s.close);
  if (!target) return null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-5xl w-[min(94vw,1040px)] h-[80vh] p-0 gap-0 overflow-hidden flex flex-col">
        {/* Título acessível (Radix exige um DialogTitle); o visível vive no
            header da própria LocalHistoryView. */}
        <DialogTitle className="sr-only">Local History — {basename(target.path)}</DialogTitle>
        <LocalHistoryView key={`${target.projectId}:${target.path}`} projectId={target.projectId} path={target.path} />
      </DialogContent>
    </Dialog>
  );
}
