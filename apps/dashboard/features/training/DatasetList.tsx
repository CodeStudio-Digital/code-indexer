/**
 * DatasetList — datasets for the selected project, with the acceptance rate
 * (the Phase-A success signal) front and center. Selecting one bubbles up so
 * the parent can show its examples.
 */
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { confirm } from '../../components/ui/prompt-dialog.js';
import type { TrainingDatasetDTO } from '@mcp/api-bus';
import { deleteDataset } from './api.js';

function rateColor(rate: number, status: string): 'default' | 'secondary' | 'destructive' {
  if (status === 'error') return 'destructive';
  if (rate >= 0.4 && rate <= 0.85) return 'default';
  return 'secondary';
}

export function DatasetList({
  datasets, selectedId, onSelect, onDeleted,
}: {
  datasets: TrainingDatasetDTO[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onDeleted: (id: number) => void;
}) {
  const { t } = useTranslation('training');

  if (datasets.length === 0) {
    return <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">{t('noDatasets')}</p>;
  }

  const onDelete = async (d: TrainingDatasetDTO): Promise<void> => {
    const ok = await confirm({
      title: t('deleteTitle'),
      description: t('deleteConfirm', { name: d.name }),
      confirmLabel: t('delete'),
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await deleteDataset(d.id);
      onDeleted(d.id);
    } catch { /* ignore */ }
  };

  return (
    <ul className="space-y-1">
      {datasets.map((d) => (
        <li
          key={d.id}
          className={`group flex items-center gap-1 rounded-md border pr-1 hover:bg-accent ${
            selectedId === d.id ? 'border-primary' : ''
          }`}
        >
          <button onClick={() => onSelect(d.id)} className="flex min-w-0 flex-1 items-center justify-between px-3 py-2 text-left text-sm">
            <span className="truncate">
              <span className="font-medium">{d.name}</span>
              <span className="ml-2 text-muted-foreground">#{d.id} · {d.stackProfile}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {d.status !== 'done' && <Badge variant="secondary">{d.status}</Badge>}
              <Badge variant={rateColor(d.acceptanceRate, d.status)}>
                {Math.round(d.acceptanceRate * 100)}% · {d.acceptedCount}/{d.exampleCount}
              </Badge>
            </span>
          </button>
          <button
            onClick={() => void onDelete(d)}
            title={t('delete')}
            className="rounded p-1.5 text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </li>
      ))}
    </ul>
  );
}
