/**
 * Faixa de status no topo da aba Index — sempre visível acima das sub-abas.
 * Reaproveita o IndexStatusChip da StatusBar (fase + progresso ao vivo, agora
 * vindo do `activeRun` do store, então sobrevive à navegação) e mostra as
 * contagens file/symbol da mesma frame ao vivo.
 */
import { useTranslation } from 'react-i18next';
import { IndexStatusChip } from '../../../workspace/jetbrains/status-bar/IndexStatusChip.js';
import { useIndexStatus } from '../../../workspace/jetbrains/status-bar/useIndexStatus.js';

export function IndexHeaderStrip({ projectId }: { projectId: number }) {
  const { t } = useTranslation('projects');
  const status = useIndexStatus(projectId);
  return (
    <div className="flex items-center gap-3 border-b px-4 py-2 text-xs shrink-0">
      <IndexStatusChip status={status} />
      {status && (
        <span className="text-muted-foreground tabular-nums">
          {status.fileCount} {t('files')} · {status.symbolCount} {t('symbols')}
        </span>
      )}
    </div>
  );
}
