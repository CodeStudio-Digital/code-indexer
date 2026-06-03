/**
 * TrainingTab — Phase A workbench. Pick a project, generate a stack dataset
 * with live progress, then inspect datasets + examples to judge quality
 * (acceptance rate + read the outputs). Training/serving land in later phases.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GraduationCap } from 'lucide-react';
import { useApi } from '../../hooks/useApi.js';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select.js';
import type { TrainingDatasetDTO } from '@mcp/api-bus';
import { listDatasets } from './api.js';
import { BuildDatasetForm } from './BuildDatasetForm.js';
import { DatasetList } from './DatasetList.js';
import { ExampleViewer } from './ExampleViewer.js';
import { StatCard } from './StatCard.js';

interface ProjectLite { id: number; name: string }

export function TrainingTab() {
  const { t } = useTranslation('training');
  const { data: projects } = useApi<ProjectLite[]>('/projects');
  const [projectId, setProjectId] = useState<number | null>(null);
  const [datasets, setDatasets] = useState<TrainingDatasetDTO[]>([]);
  const [selectedDataset, setSelectedDataset] = useState<number | null>(null);

  useEffect(() => {
    if (projectId === null && projects && projects.length > 0) setProjectId(projects[0].id);
  }, [projects, projectId]);

  const refreshDatasets = useCallback(() => {
    if (projectId === null) return;
    void listDatasets(projectId).then(setDatasets).catch(() => setDatasets([]));
  }, [projectId]);

  useEffect(() => { refreshDatasets(); setSelectedDataset(null); }, [refreshDatasets]);

  const summary = useMemo(
    () => datasets.find((d) => d.id === selectedDataset) ?? datasets[0],
    [datasets, selectedDataset],
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
            <GraduationCap className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">{t('title')}</h1>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
        </div>
        <Select
          value={projectId !== null ? String(projectId) : undefined}
          onValueChange={(v) => setProjectId(Number(v))}
        >
          <SelectTrigger className="w-64"><SelectValue placeholder={t('selectProject')} /></SelectTrigger>
          <SelectContent>
            {(projects ?? []).map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </header>

      {summary && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard
            label={t('stat.acceptance')}
            value={`${Math.round(summary.acceptanceRate * 100)}%`}
            intent={summary.acceptanceRate >= 0.4 ? 'good' : 'warn'}
          />
          <StatCard label={t('stat.accepted')} value={`${summary.acceptedCount}/${summary.exampleCount}`} />
          <StatCard label={t('stat.cost')} value={`$${summary.costUsd.toFixed(4)}`} />
          <StatCard label={t('stat.status')} value={summary.status} />
        </div>
      )}

      {projectId === null ? (
        <p className="text-sm text-muted-foreground">{t('selectProject')}</p>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <BuildDatasetForm projectId={projectId} onCreated={refreshDatasets} />
            <div className="space-y-2">
              <h2 className="text-sm font-semibold">{t('datasets')}</h2>
              <DatasetList
                datasets={datasets}
                selectedId={selectedDataset}
                onSelect={setSelectedDataset}
                onDeleted={(id) => { if (selectedDataset === id) setSelectedDataset(null); refreshDatasets(); }}
              />
            </div>
          </div>
          <div className="space-y-2">
            <h2 className="text-sm font-semibold">{t('examples')}</h2>
            {selectedDataset !== null
              ? <ExampleViewer datasetId={selectedDataset} />
              : <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{t('selectDataset')}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
