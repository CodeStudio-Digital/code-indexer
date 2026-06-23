/**
 * Surface destacável do Local History (alvo da rota /popout/local-history).
 * Parseia os params da query (projectId, path) e renderiza a LocalHistoryView
 * full-window. Carregado lazy pelo registry para não puxar o chunk pesado
 * (Monaco via LazyHistoryDiff) ao apenas importar o registro.
 */
import { LocalHistoryView } from '../../workspace/local-history/LocalHistoryView.js';
import type { SurfaceParams } from '../registry.js';

export default function LocalHistorySurface({ params }: { params: SurfaceParams }) {
  const projectId = Number(params.projectId);
  const path = params.path ?? '';
  if (!Number.isFinite(projectId) || !path) {
    return (
      <div className="h-full grid place-items-center text-muted-foreground text-sm">
        Invalid Local History target.
      </div>
    );
  }
  return <LocalHistoryView projectId={projectId} path={path} />;
}
