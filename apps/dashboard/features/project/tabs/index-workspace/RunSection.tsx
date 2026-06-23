/**
 * Seção "Run" da aba Index: controle do indexer (RunIndexCard) + cobertura de
 * embeddings (EmbeddingsCard) + histórico (RunHistoryList). Substitui a antiga
 * RunsTab — o ciclo de vida da run vive aqui (`useIndexRun`) e é compartilhado
 * com os cards filhos para que cobertura e histórico reajam à mesma run.
 */
import { useIndexRun } from './useIndexRun.js';
import { RunIndexCard } from './RunIndexCard.js';
import { EmbeddingsCard } from './EmbeddingsCard.js';
import { RunHistoryList } from './RunHistoryList.js';

export function RunSection({ projectId }: { projectId: number }) {
  const run = useIndexRun(projectId);
  return (
    <div className="space-y-6">
      <RunIndexCard projectId={projectId} run={run} />
      <EmbeddingsCard projectId={projectId} indexRunning={run.isRunning} coverageRefreshKey={run.progress.status} />
      <RunHistoryList projectId={projectId} refreshKey={run.progress.status} />
    </div>
  );
}
