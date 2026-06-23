/**
 * Lazy boundary do painel de diff do Local History — mantém o chunk pesado do
 * Monaco fora do payload inicial do diálogo. O conteúdo real (DiffEditor
 * side-by-side, estilo IntelliJ) vive em HistoryDiffImpl.
 */
import { lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';

export interface HistoryDiffProps {
  /** Versão selecionada (painel esquerdo / "before"). */
  original: string;
  /** Conteúdo atual no disco (painel direito / "current"). */
  modified: string;
  /** Language id do Monaco, derivado do caminho do arquivo. */
  language: string;
}

const Inner = lazy(() => import('./HistoryDiffImpl.js'));

export function LazyHistoryDiff(props: HistoryDiffProps) {
  return (
    <Suspense
      fallback={
        <div className="h-full flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <Inner {...props} />
    </Suspense>
  );
}
