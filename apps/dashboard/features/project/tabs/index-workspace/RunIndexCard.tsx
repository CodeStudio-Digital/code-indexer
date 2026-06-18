/**
 * Card "Run Index" (extraído da RunsTab): picker provider/model, concorrência,
 * force-reindex, bloco de progresso e botões Run/Cancel/Clear. O ciclo de vida
 * da run vem do hook `useIndexRun` (prop `run`) para que EmbeddingsCard e o
 * histórico possam reagir ao mesmo estado.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleStop, PlayCircle, RefreshCw, Sparkles } from 'lucide-react';
import { Badge } from '../../../../components/ui/badge.js';
import { Button } from '../../../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../../../components/ui/card.js';
import { Input } from '../../../../components/ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../../components/ui/select.js';
import { Switch } from '../../../../components/ui/switch.js';
import { useProviderModels } from './useProviderModels.js';
import { RunProgressBlock } from './RunProgressBlock.js';
import type { IndexRun } from './useIndexRun.js';

export function RunIndexCard({ projectId: _projectId, run }: { projectId: number; run: IndexRun }) {
  const { t } = useTranslation(['projects', 'common']);
  const { modelsLoading, providerKinds, availableModels, kind, setKind, model, setModel, providerDisabled } =
    useProviderModels();
  const [force, setForce] = useState(false);
  const [concurrent, setConcurrent] = useState(5);

  const { progress, isRunning } = run;
  const canRun = !isRunning && !!kind && !!model;
  const finished = progress.status === 'done' || progress.status === 'error' || progress.status === 'canceled';

  return (
    <Card className="border-primary/30 bg-gradient-to-br from-primary/5 via-transparent to-transparent">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary text-primary-foreground flex items-center justify-center shadow-sm">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">{t('projects:runs.title')}</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">{t('projects:runs.description')}</p>
            </div>
          </div>
          <Badge variant={isRunning ? 'warning' : 'muted'}>
            {isRunning
              ? t('projects:runs.badge.running')
              : progress.status === 'done'
                ? t('projects:runs.badge.done')
                : progress.status === 'error'
                  ? t('projects:runs.badge.error')
                  : progress.status === 'canceled'
                    ? t('projects:runs.badge.canceled')
                    : t('projects:runs.badge.idle')}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t('projects:runs.provider')}
            </label>
            <Select value={kind || undefined} onValueChange={setKind} disabled={providerDisabled || isRunning || modelsLoading}>
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    modelsLoading
                      ? t('projects:runs.providerLoading')
                      : providerDisabled
                        ? t('projects:runs.providerDisabled')
                        : t('projects:runs.providerPlaceholder')
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {providerKinds.map((k) => (
                  <SelectItem key={k} value={k}>{k}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t('projects:runs.model')}
            </label>
            <Select
              value={model || undefined}
              onValueChange={setModel}
              disabled={providerDisabled || isRunning || modelsLoading || availableModels.length === 0}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    modelsLoading
                      ? t('projects:runs.modelLoading')
                      : availableModels.length === 0
                        ? t('projects:runs.modelEmpty')
                        : t('projects:runs.modelPlaceholder')
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {availableModels.map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.name || m.id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {kind && !modelsLoading && availableModels.length === 0 && (
              <p className="text-xs text-warning">{t('projects:runs.noModels', { kind })}</p>
            )}
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t('projects:runs.concurrent')}
          </label>
          <Input
            type="number"
            min={1}
            value={concurrent}
            disabled={isRunning}
            onChange={(e) => setConcurrent(Math.max(1, Number(e.target.value) || 1))}
          />
        </div>
        <div className="flex items-center justify-between rounded-lg border bg-card px-3 py-2">
          <div className="flex items-center gap-3">
            <Switch checked={force} onCheckedChange={setForce} disabled={isRunning} id="force-reindex" />
            <label htmlFor="force-reindex" className="text-sm cursor-pointer select-none">
              <span className="font-medium">{t('projects:runs.forceReindex')}</span>
              <span className="text-muted-foreground ml-2 text-xs">{t('projects:runs.forceReindexHint')}</span>
            </label>
          </div>
        </div>

        <RunProgressBlock progress={progress} />

        <div className="flex items-center gap-2">
          {isRunning ? (
            <Button variant="destructive" onClick={run.cancelIndex} className="gap-2">
              <CircleStop className="h-4 w-4" /> {t('common:actions.cancel')}
            </Button>
          ) : (
            <Button
              onClick={() => run.startIndex({ provider: kind || undefined, model: model || undefined, force, concurrent })}
              disabled={!canRun}
              className="gap-2"
            >
              <PlayCircle className="h-4 w-4" />
              {finished ? t('projects:runs.runAgain') : t('projects:runs.runIndex')}
            </Button>
          )}
          {finished && (
            <Button variant="ghost" onClick={run.resetProgress} className="gap-2">
              <RefreshCw className="h-4 w-4" /> {t('common:actions.clear')}
            </Button>
          )}
          {providerDisabled && !isRunning && (
            <p className="text-xs text-muted-foreground">{t('projects:runs.configureProvider')}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
