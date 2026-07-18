import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Code2,
  Database,
  HardDrive,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../components/ui/card.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { confirm as confirmDialog, toast } from '../../components/ui/prompt-dialog.js';
import { Progress } from '../../components/ui/progress.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Switch } from '../../components/ui/switch.js';
import { fetchProviders } from './api.js';
import type { AdminProvider } from './types.js';
import {
  cleanupUnusedSemanticVectors,
  fetchSemanticGenerations,
  fetchSemanticModels,
  fetchSemanticProfiles,
  fetchProjectSemanticStatuses,
  probeSemanticTarget,
  reindexProjectSemanticCode,
  reindexSemanticProfile,
  saveSemanticProfile,
  semanticJobIsExecuting,
  type SemanticGenerationView,
  type SemanticJobView,
  type SemanticModelView,
  type SemanticProbeResult,
  type SemanticRerankerStatusView,
  type ProjectSemanticStatusResult,
  type SemanticNamespaceStatusView,
  type SemanticOnnxDtype,
  type SemanticProfilePurpose,
  type SemanticProfileView,
  type SemanticTarget,
  type SemanticTargetKind,
  type SemanticUnusedVectorCleanupResult,
} from './semantic-api.js';
import {
  summarizeProjectSemanticScopes,
  summarizeProjectVectorStorage,
  type ProjectSemanticScope,
} from './semantic-project-status.js';

const PURPOSES: SemanticProfilePurpose[] = ['code', 'docs', 'memory'];

function defaultTarget(capability: 'embedding' | 'rerank'): SemanticTarget {
  if (capability === 'embedding') {
    return {
      kind: 'onnx',
      model: 'Xenova/multilingual-e5-small',
      dtype: 'q8',
      pooling: 'mean',
      normalize: true,
    };
  }
  return { kind: 'onnx', model: 'auto', dtype: 'q8' };
}

function fallbackProfile(purpose: SemanticProfilePurpose): SemanticProfileView {
  return {
    purpose,
    embedding_target: defaultTarget('embedding'),
    reranker_target: defaultTarget('rerank'),
  };
}

function targetModel(target: SemanticTarget): string | null {
  return target.kind === 'disabled' ? null : target.model;
}

function targetSource(target: SemanticTarget, providers: AdminProvider[]): string {
  if (target.kind === 'provider') {
    return providers.find((provider) => provider.id === target.providerId)?.name ?? target.providerId;
  }
  if (target.kind === 'local_http') return target.baseUrl;
  if (target.kind === 'onnx') return `${target.kind} · ${target.dtype ?? 'q8'}`;
  return target.kind;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function targetIsComplete(target: SemanticTarget): boolean {
  if (target.kind === 'disabled') return true;
  if (!target.model.trim()) return false;
  if (target.kind === 'provider') return !!target.providerId.trim();
  if (target.kind === 'local_http') return isLoopbackUrl(target.baseUrl);
  return true;
}

function modelId(model: SemanticModelView): string {
  return model.model_id;
}

function latestGeneration(
  purpose: SemanticProfilePurpose,
  generations: SemanticGenerationView[],
): SemanticGenerationView | null {
  const matches = generations.filter((generation) => generation.purpose === purpose);
  const building = matches.find((generation) => generation.status === 'building');
  if (building) return building;
  return matches[0] ?? null;
}

function generationProgress(generation: SemanticGenerationView | null): {
  indexed: number;
  total: number;
  failed: number;
  percent: number;
} {
  const indexed = generation?.indexed_items ?? 0;
  const total = generation?.expected_items ?? 0;
  const failed = generation?.failed_items ?? 0;
  return {
    indexed,
    total,
    failed,
    percent: total > 0 ? Math.min(100, (indexed / total) * 100) : 0,
  };
}

function generationVariant(status: string | undefined) {
  if (status === 'ready') return 'success' as const;
  if (status === 'failed') return 'destructive' as const;
  if (status === 'building') return 'info' as const;
  if (status === 'retired') return 'muted' as const;
  return 'warning' as const;
}

function semanticJobPurpose(
  job: SemanticJobView,
  generations: SemanticGenerationView[],
): SemanticProfilePurpose | null {
  if (job.namespace === 'semantic:reindex:code'
    || job.namespace.startsWith('semantic:reindex:code:p')
    || job.namespace.startsWith('code:p')) return 'code';
  if (job.namespace === 'semantic:reindex:docs'
    || job.namespace.startsWith('docs:')) return 'docs';
  if (job.namespace === 'semantic:reindex:memory'
    || job.namespace.startsWith('snapshot:p')
    || job.namespace.startsWith('memory:')) return 'memory';
  if (job.generation_id != null) {
    return generations.find((generation) => Number(generation.id) === job.generation_id)?.purpose ?? null;
  }
  return null;
}

function isExecutingSemanticJob(job: SemanticJobView): boolean {
  return semanticJobIsExecuting(job);
}

function latestPurposeJob(
  purpose: SemanticProfilePurpose,
  jobs: SemanticJobView[],
  generations: SemanticGenerationView[],
): SemanticJobView | null {
  const matches = jobs
    .filter((job) => semanticJobPurpose(job, generations) === purpose)
    .sort((left, right) => right.id - left.id);
  return matches.find(isExecutingSemanticJob)
    ?? matches[0]
    ?? null;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / (1024 ** unit);
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function coveragePercent(status: SemanticNamespaceStatusView | null): number {
  if (!status?.expected_items) return 0;
  return Math.min(100, (status.indexed_items / status.expected_items) * 100);
}

function targetForKind(
  kind: SemanticTargetKind,
  capability: 'embedding' | 'rerank',
  providers: AdminProvider[],
): SemanticTarget {
  if (kind === 'disabled') return { kind: 'disabled' };
  if (kind === 'onnx') return defaultTarget(capability);
  if (kind === 'local_http') {
    return {
      kind,
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: '',
      protocol: capability === 'embedding' ? 'openai-embeddings' : 'openai-rerank',
    };
  }
  const provider = providers.find((item) => item.enabled) ?? providers[0];
  const protocol =
    provider?.kind === 'cloudflare'
      ? 'cloudflare'
      : provider?.kind === 'bedrock'
        ? 'bedrock'
        : capability === 'embedding'
          ? 'openai-embeddings'
          : 'openai-rerank';
  return { kind, providerId: provider?.id ?? '', model: '', protocol };
}

interface TargetEditorProps {
  capability: 'embedding' | 'rerank';
  target: SemanticTarget;
  providers: AdminProvider[];
  onChange: (target: SemanticTarget) => void;
}

function TargetEditor({ capability, target, providers, onChange }: TargetEditorProps) {
  const { t } = useTranslation('admin');
  const [models, setModels] = useState<SemanticModelView[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const providerId = target.kind === 'provider' ? target.providerId : undefined;
  const automaticModelAvailable = capability === 'rerank' && target.kind === 'onnx';

  useEffect(() => {
    if (target.kind === 'disabled' || (target.kind === 'provider' && !providerId)) {
      setModels([]);
      return;
    }
    let alive = true;
    setModelsLoading(true);
    setModelsError(null);
    void fetchSemanticModels(capability, providerId)
      .then((nextModels) => {
        if (!alive) return;
        setModels(nextModels);
        const currentModel = targetModel(target);
        setCustomModel(!!currentModel
          && currentModel !== 'auto'
          && !nextModels.some((model) => modelId(model) === currentModel));
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setModels([]);
        setModelsError(error instanceof Error ? error.message : String(error));
        // `auto` is a local policy, not a catalog entry. Keep it selectable
        // even when model discovery is unavailable.
        setCustomModel(targetModel(target) !== 'auto');
      })
      .finally(() => {
        if (alive) setModelsLoading(false);
      });
    return () => {
      alive = false;
    };
    // The target model is deliberately excluded: choosing a model must not refetch the catalog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capability, providerId, target.kind]);

  const selectableModels = useMemo(() => {
    if (target.kind !== 'provider') return models.filter((model) => !model.provider_id);
    return models.filter((model) => !model.provider_id || model.provider_id === target.providerId);
  }, [models, target]);

  function update(values: Record<string, unknown>) {
    onChange({ ...target, ...values } as SemanticTarget);
  }

  function updateProvider(nextProviderId: string) {
    const provider = providers.find((item) => item.id === nextProviderId);
    const protocol =
      provider?.kind === 'cloudflare'
        ? 'cloudflare'
        : provider?.kind === 'bedrock'
          ? 'bedrock'
          : capability === 'embedding'
            ? 'openai-embeddings'
            : 'openai-rerank';
    onChange({ kind: 'provider', providerId: nextProviderId, model: '', protocol });
    setCustomModel(false);
  }

  function updateModel(nextModel: string) {
    const selected = selectableModels.find((model) => modelId(model) === nextModel);
    const detectedTarget = selected?.config?.target as
      | { kind?: string; protocol?: string }
      | undefined;
    update({
      model: nextModel,
      ...(nextModel === 'auto' ? { revision: undefined } : {}),
      ...(target.kind === 'provider'
        && detectedTarget?.kind === 'provider'
        && typeof detectedTarget.protocol === 'string'
        ? { protocol: detectedTarget.protocol }
        : {}),
    });
  }

  function toggleCustomModel(enabled: boolean) {
    setCustomModel(enabled);
    const currentModel = targetModel(target) ?? '';
    if (enabled) {
      // Do not make users erase the policy sentinel before typing an ID.
      if (automaticModelAvailable && currentModel === 'auto') update({ model: '' });
      return;
    }
    if (automaticModelAvailable) {
      updateModel(selectableModels.some((model) => modelId(model) === currentModel)
        ? currentModel
        : 'auto');
      return;
    }
    if (!selectableModels.some((model) => modelId(model) === currentModel)) {
      const firstModel = selectableModels[0];
      if (firstModel) updateModel(modelId(firstModel));
    }
  }

  const currentModel = targetModel(target) ?? '';
  const localUrlInvalid = target.kind === 'local_http' && !isLoopbackUrl(target.baseUrl);

  return (
    <div className="space-y-3 rounded-lg border bg-muted/10 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">
            {t(`semantic.capability.${capability}.title`)}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t(`semantic.capability.${capability}.description`)}
          </p>
        </div>
        {target.kind === 'disabled' && (
          <Badge variant="muted">{t('semantic.status.disabled')}</Badge>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium">{t('semantic.form.runtime')}</label>
          <Select
            value={target.kind}
            onValueChange={(value) =>
              onChange(targetForKind(value as SemanticTargetKind, capability, providers))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['onnx', 'local_http', 'provider', 'disabled'] as SemanticTargetKind[]).map(
                (kind) => (
                  <SelectItem key={kind} value={kind}>
                    {t(`semantic.targetKinds.${kind}`)}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>

        {target.kind === 'provider' && (
          <div>
            <label className="mb-1 block text-xs font-medium">{t('semantic.form.provider')}</label>
            <Select value={target.providerId} onValueChange={updateProvider}>
              <SelectTrigger>
                <SelectValue placeholder={t('semantic.form.selectProvider')} />
              </SelectTrigger>
              <SelectContent>
                {providers
                  .filter((provider) => provider.enabled)
                  .map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.name} ({provider.kind})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {target.kind === 'local_http' && (
          <div>
            <label className="mb-1 block text-xs font-medium">{t('semantic.form.endpoint')}</label>
            <Input
              value={target.baseUrl}
              onChange={(event) => update({ baseUrl: event.target.value })}
              placeholder={t('semantic.form.endpointPlaceholder')}
            />
            {localUrlInvalid && (
              <p className="mt-1 text-xs text-destructive">{t('semantic.form.loopbackOnly')}</p>
            )}
          </div>
        )}
      </div>

      {target.kind !== 'disabled' && (
        <>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div>
              <div className="mb-1 flex items-center justify-between gap-3">
                <label className="text-xs font-medium">{t('semantic.form.model')}</label>
                {modelsLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              </div>
              {customModel || (selectableModels.length === 0 && !automaticModelAvailable) ? (
                <Input
                  value={currentModel}
                  onChange={(event) => update({ model: event.target.value })}
                  placeholder={
                    capability === 'embedding'
                      ? 'Xenova/multilingual-e5-small'
                      : 'Xenova/bge-reranker-base'
                  }
                />
              ) : (
                <Select value={currentModel} onValueChange={updateModel}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('semantic.form.selectModel')} />
                  </SelectTrigger>
                  <SelectContent>
                    {automaticModelAvailable && (
                      <SelectItem value="auto">{t('semantic.form.automaticModel')}</SelectItem>
                    )}
                    {selectableModels.map((model) => (
                      <SelectItem key={model.id} value={modelId(model)}>
                        {modelId(model)} · {t(`semantic.modelSource.${model.source}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {modelsError && (
                <p className="mt-1 text-xs text-warning">
                  {t('semantic.form.catalogUnavailable', { message: modelsError })}
                </p>
              )}
            </div>
            <label className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={customModel}
                disabled={selectableModels.length === 0 && !automaticModelAvailable}
                onCheckedChange={toggleCustomModel}
              />
              {t('semantic.form.customModel')}
            </label>
          </div>

          {(target.kind === 'provider' || target.kind === 'local_http') && (
            <div>
              <label className="mb-1 block text-xs font-medium">{t('semantic.form.protocol')}</label>
              <Select
                value={target.protocol}
                onValueChange={(value) => update({ protocol: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {capability === 'embedding' ? (
                    <SelectItem value="openai-embeddings">
                      {t('semantic.protocol.openaiEmbeddings')}
                    </SelectItem>
                  ) : (
                    <>
                      <SelectItem value="openai-rerank">
                        {t('semantic.protocol.openaiRerank')}
                      </SelectItem>
                      <SelectItem value="cohere-rerank">
                        {t('semantic.protocol.cohereRerank')}
                      </SelectItem>
                    </>
                  )}
                  {target.kind === 'provider' && (
                    <>
                      <SelectItem value="cloudflare">{t('semantic.protocol.cloudflare')}</SelectItem>
                      <SelectItem value="bedrock">{t('semantic.protocol.bedrock')}</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          {target.kind === 'onnx' && (
            <div className="space-y-3 border-t pt-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium">{t('semantic.form.advanced')}</p>
                  <p className="text-xs text-muted-foreground">{t('semantic.form.advancedHelp')}</p>
                </div>
                <Switch checked={advanced} onCheckedChange={setAdvanced} />
              </div>
              {advanced && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium">
                      {t('semantic.form.dtype')}
                    </label>
                    <Select
                      value={target.dtype ?? 'q8'}
                      onValueChange={(value) => update({ dtype: value as SemanticOnnxDtype })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="q8">{`q8 (${t('semantic.form.dtypeRecommended')})`}</SelectItem>
                        <SelectItem value="q4">{'q4'}</SelectItem>
                        <SelectItem value="fp16">{'fp16'}</SelectItem>
                        <SelectItem value="fp32">{'fp32'}</SelectItem>
                      </SelectContent>
                    </Select>
                    {target.dtype === 'fp32' && (
                      <p className="mt-1 text-xs text-warning">
                        {t('semantic.form.fp32Warning')}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium">
                      {t('semantic.form.revision')}
                    </label>
                    <Input
                      value={target.revision ?? ''}
                      onChange={(event) => update({ revision: event.target.value || undefined })}
                      placeholder={t('semantic.form.revisionPlaceholder')}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium">
                      {t('semantic.form.maxTokens')}
                    </label>
                    <Input
                      type="number"
                      min={1}
                      value={target.maxTokens ?? ''}
                      onChange={(event) =>
                        update({
                          maxTokens: event.target.value ? Number(event.target.value) : undefined,
                        })
                      }
                    />
                  </div>
                  {capability === 'embedding' && (
                    <>
                      <div>
                        <label className="mb-1 block text-xs font-medium">
                          {t('semantic.form.pooling')}
                        </label>
                        <Select
                          value={target.pooling ?? 'mean'}
                          onValueChange={(value) => update({ pooling: value })}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="mean">{t('semantic.pooling.mean')}</SelectItem>
                            <SelectItem value="cls">{t('semantic.pooling.cls')}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <label className="flex items-end gap-2 pb-2 text-xs">
                        <Switch
                          checked={target.normalize ?? true}
                          onCheckedChange={(value) => update({ normalize: value })}
                        />
                        {t('semantic.form.normalize')}
                      </label>
                      <div>
                        <label className="mb-1 block text-xs font-medium">
                          {t('semantic.form.queryTemplate')}
                        </label>
                        <Input
                          value={target.queryTemplate ?? ''}
                          onChange={(event) =>
                            update({ queryTemplate: event.target.value || undefined })
                          }
                          placeholder={t('semantic.form.queryTemplatePlaceholder', {
                            text: '{{text}}',
                          })}
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium">
                          {t('semantic.form.documentTemplate')}
                        </label>
                        <Input
                          value={target.documentTemplate ?? ''}
                          onChange={(event) =>
                            update({ documentTemplate: event.target.value || undefined })
                          }
                          placeholder={t('semantic.form.documentTemplatePlaceholder', {
                            text: '{{text}}',
                          })}
                        />
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface ProfileDialogProps {
  profile: SemanticProfileView;
  providers: AdminProvider[];
  onClose: () => void;
  onSaved: (profile: SemanticProfileView) => void;
}

type ProbeState =
  | { status: 'idle' | 'testing' }
  | {
      status: 'success';
      signature: string;
      results: Array<{ capability: 'embedding' | 'rerank'; result: SemanticProbeResult }>;
    }
  | { status: 'error'; message: string };

function ProfileDialog({ profile, providers, onClose, onSaved }: ProfileDialogProps) {
  const { t } = useTranslation(['admin', 'common']);
  const [embeddingTarget, setEmbeddingTarget] = useState<SemanticTarget>(profile.embedding_target);
  const [rerankerTarget, setRerankerTarget] = useState<SemanticTarget>(profile.reranker_target);
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const signature = useMemo(
    () => JSON.stringify({ embedding_target: embeddingTarget, reranker_target: rerankerTarget }),
    [embeddingTarget, rerankerTarget],
  );
  const complete = targetIsComplete(embeddingTarget) && targetIsComplete(rerankerTarget);
  const probeCurrent = probe.status === 'success' && probe.signature === signature;

  const usesHeavyFp32 = [embeddingTarget, rerankerTarget].some(
    (target) => target.kind === 'onnx' && target.dtype === 'fp32',
  );

  function confirmHeavyFp32(): Promise<boolean> {
    if (!usesHeavyFp32) return Promise.resolve(true);
    return confirmDialog({
      title: t('semantic.form.fp32Warning'),
      description: t('semantic.actions.fp32Confirm'),
      confirmLabel: t('common:actions.confirm'),
      tone: 'destructive',
    });
  }

  function changeEmbedding(target: SemanticTarget) {
    setEmbeddingTarget(target);
    setProbe({ status: 'idle' });
  }

  function changeReranker(target: SemanticTarget) {
    setRerankerTarget(target);
    setProbe({ status: 'idle' });
  }

  async function runProbe() {
    if (!(await confirmHeavyFp32())) return;
    setProbe({ status: 'testing' });
    setSaveError(null);
    try {
      const targets: Array<{
        capability: 'embedding' | 'rerank';
        target: SemanticTarget;
      }> = [];
      if (embeddingTarget.kind !== 'disabled') {
        targets.push({ capability: 'embedding', target: embeddingTarget });
      }
      if (rerankerTarget.kind !== 'disabled') {
        targets.push({ capability: 'rerank', target: rerankerTarget });
      }
      const results: Array<{
        capability: 'embedding' | 'rerank';
        result: SemanticProbeResult;
      }> = [];
      // Probe one local model at a time. Running embedder and reranker probes
      // concurrently can briefly double ONNX memory usage.
      for (const { capability, target } of targets) {
        results.push({
          capability,
          result: await probeSemanticTarget(capability, target, usesHeavyFp32),
        });
      }
      const failed = results.find(({ result }) => !result.ok);
      if (failed) throw new Error(failed.result.error ?? t('semantic.probe.failed'));
      setProbe({ status: 'success', signature, results });
    } catch (error) {
      setProbe({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function save() {
    if (!probeCurrent) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveSemanticProfile(profile.purpose, {
        embedding_target: embeddingTarget,
        reranker_target: rerankerTarget,
      }, usesHeavyFp32);
      onSaved(saved);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t('semantic.dialog.title', { purpose: t(`semantic.purpose.${profile.purpose}.title`) })}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <TargetEditor
            capability="embedding"
            target={embeddingTarget}
            providers={providers}
            onChange={changeEmbedding}
          />
          <TargetEditor
            capability="rerank"
            target={rerankerTarget}
            providers={providers}
            onChange={changeReranker}
          />

          {!complete && (
            <Alert variant="warning">
              <AlertCircle />
              <AlertTitle>{t('semantic.validation.title')}</AlertTitle>
              <AlertDescription>{t('semantic.validation.incomplete')}</AlertDescription>
            </Alert>
          )}

          {probe.status === 'success' && probeCurrent && (
            <Alert variant="success">
              <CheckCircle2 />
              <AlertTitle>{t('semantic.probe.successTitle')}</AlertTitle>
              <AlertDescription>
                {probe.results.length === 0
                  ? t('semantic.probe.disabledTargets')
                  : probe.results
                      .map(({ capability, result }) =>
                        t('semantic.probe.result', {
                          capability: t(`semantic.capability.${capability}.title`),
                          latency: result.latency_ms ?? 0,
                          dimensions: result.dimensions ?? '—',
                        }),
                      )
                      .join(' · ')}
              </AlertDescription>
            </Alert>
          )}

          {probe.status === 'error' && (
            <Alert variant="destructive">
              <XCircle />
              <AlertTitle>{t('semantic.probe.errorTitle')}</AlertTitle>
              <AlertDescription>{probe.message}</AlertDescription>
            </Alert>
          )}

          {saveError && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>{t('semantic.save.errorTitle')}</AlertTitle>
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <p className="mr-auto max-w-sm text-xs text-muted-foreground">
            {probeCurrent ? t('semantic.probe.current') : t('semantic.probe.required')}
          </p>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="outline" onClick={() => void runProbe()} disabled={!complete || probe.status === 'testing'}>
            {probe.status === 'testing' ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            {t('semantic.probe.action')}
          </Button>
          <Button onClick={() => void save()} disabled={!probeCurrent || saving}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {t('common:actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ProfileCardProps {
  profile: SemanticProfileView;
  generation: SemanticGenerationView | null;
  job: SemanticJobView | null;
  rerankerStatus: SemanticRerankerStatusView;
  providers: AdminProvider[];
  reindexing: boolean;
  onEdit: () => void;
  onReindex: () => void;
}

function ProfileCard({
  profile,
  generation,
  job,
  rerankerStatus,
  providers,
  reindexing,
  onEdit,
  onReindex,
}: ProfileCardProps) {
  const { t } = useTranslation('admin');
  const progress = generationProgress(generation);
  const disabled = profile.embedding_target.kind === 'disabled';
  const executing = reindexing || (!!job && isExecutingSemanticJob(job));
  const status = disabled
    ? 'disabled'
    : executing
      ? 'building'
      : job?.status === 'paused'
        ? 'paused'
        : job?.status === 'pending'
          ? 'pending'
          : generation?.status === 'building'
            ? 'paused'
            : generation?.status ?? 'pending';
  const PurposeIcon = profile.purpose === 'code'
    ? Code2
    : profile.purpose === 'docs'
      ? BookOpen
      : Sparkles;
  const rerankerDiagnostics = rerankerStatus.diagnostics;
  const localReranker = profile.reranker_target.kind === 'onnx';

  return (
    <Card className="flex min-h-[430px] flex-col">
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="rounded-lg border bg-muted/40 p-2">
              <PurposeIcon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">
                {t(`semantic.purpose.${profile.purpose}.title`)}
              </CardTitle>
              <CardDescription className="mt-1">
                {t(`semantic.purpose.${profile.purpose}.description`)}
              </CardDescription>
            </div>
          </div>
          <Badge variant={disabled ? 'muted' : generationVariant(status)}>
            {t(`semantic.status.${status}`, { defaultValue: status })}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex-1 space-y-4">
        <div className="grid gap-2">
          <div className="rounded-lg border bg-muted/10 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('semantic.summary.embedding')}
            </p>
            <p className="mt-1 truncate text-sm font-medium">
              {targetModel(profile.embedding_target) ?? t('semantic.status.disabled')}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {targetSource(profile.embedding_target, providers)}
            </p>
          </div>
          <div className="rounded-lg border bg-muted/10 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('semantic.summary.reranker')}
            </p>
            <p className="mt-1 truncate text-sm font-medium">
              {targetModel(profile.reranker_target) === 'auto'
                ? t('semantic.form.automaticModel')
                : targetModel(profile.reranker_target) ?? t('semantic.status.disabled')}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {targetSource(profile.reranker_target, providers)}
            </p>
          </div>
        </div>

        {localReranker && (
          <div className="rounded-lg border bg-muted/10 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('semantic.rerankerRuntime.title')}
              </p>
              {rerankerDiagnostics && (
                <Badge variant={rerankerDiagnostics.enabled ? 'success' : 'warning'}>
                  {rerankerDiagnostics.policy === 'auto'
                    ? t('semantic.rerankerRuntime.policy.auto')
                    : t('semantic.rerankerRuntime.policy.explicit')}
                </Badge>
              )}
            </div>
            {rerankerStatus.error ? (
              <p className="mt-2 text-xs text-destructive">
                {t('semantic.rerankerRuntime.error', { message: rerankerStatus.error })}
              </p>
            ) : rerankerDiagnostics ? (
              <>
                <dl className="mt-2 grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">
                      {t('semantic.rerankerRuntime.effectiveModel')}
                    </dt>
                    <dd className="truncate font-medium" title={rerankerDiagnostics.resolved_model ?? undefined}>
                      {rerankerDiagnostics.resolved_model ?? t('semantic.rerankerRuntime.rrfFallback')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('semantic.rerankerRuntime.dtype')}</dt>
                    <dd className="font-medium">{rerankerDiagnostics.dtype}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('semantic.rerankerRuntime.memory')}</dt>
                    <dd className="font-medium">{formatBytes(rerankerDiagnostics.estimated_peak_bytes)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('semantic.rerankerRuntime.provider')}</dt>
                    <dd className="font-medium">{rerankerDiagnostics.execution_provider}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('semantic.rerankerRuntime.lastLatency')}</dt>
                    <dd className="font-medium">
                      {rerankerDiagnostics.last_latency_ms == null
                        ? t('semantic.rerankerRuntime.notMeasured')
                        : `${Math.round(rerankerDiagnostics.last_latency_ms)} ms`}
                    </dd>
                  </div>
                </dl>
                {rerankerDiagnostics.downgrade_reason && (
                  <p className="mt-2 rounded-md border border-warning/30 bg-warning/5 p-2 text-xs text-warning">
                    {t('semantic.rerankerRuntime.downgrade', {
                      reason: rerankerDiagnostics.downgrade_reason,
                    })}
                  </p>
                )}
              </>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('semantic.rerankerRuntime.unavailable')}
              </p>
            )}
          </div>
        )}

        <div className="rounded-lg border border-info/30 bg-info/5 p-3">
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-info" />
            <p className="text-xs font-semibold">{t('semantic.storage.localTitle')}</p>
            <Badge variant="info">{t('semantic.storage.engine')}</Badge>
          </div>
          <div className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground">
            {profile.purpose === 'code' ? (
              <>
                <p>{t('semantic.storage.codePath')}</p>
                <p>{t('semantic.storage.codeFallback')}</p>
              </>
            ) : profile.purpose === 'docs' ? (
              <p>{t('semantic.storage.docsPath')}</p>
            ) : (
              <>
                <p>{t('semantic.storage.memoryProjectPath')}</p>
                <p>{t('semantic.storage.memoryProjectFallback')}</p>
                <p>{t('semantic.storage.memoryPath')}</p>
              </>
            )}
          </div>
        </div>

        {!disabled && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="font-medium">{t('semantic.coverage.title')}</span>
              <span className="tabular-nums text-muted-foreground">
                {progress.total > 0
                  ? t('semantic.coverage.value', {
                      indexed: progress.indexed,
                      total: progress.total,
                      percent: Math.round(progress.percent),
                    })
                  : t('semantic.coverage.waiting')}
              </span>
            </div>
            <Progress value={progress.percent} indeterminate={executing && progress.total === 0} />
            {progress.failed > 0 && (
              <p className="text-xs text-destructive">
                {t('semantic.coverage.failed', { count: progress.failed })}
              </p>
            )}
          </div>
        )}

        {generation?.error && (
          <Alert variant="destructive" className="py-2">
            <AlertCircle />
            <AlertDescription className="break-words text-xs">{generation.error}</AlertDescription>
          </Alert>
        )}
        {!generation?.error && job?.error && (
          <Alert variant="destructive" className="py-2">
            <AlertCircle />
            <AlertDescription className="break-words text-xs">{job.error}</AlertDescription>
          </Alert>
        )}
      </CardContent>

      <CardFooter className="justify-end gap-2 border-t pt-4">
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil className="mr-2 h-3.5 w-3.5" />
          {t('semantic.actions.configure')}
        </Button>
        <Button
          size="sm"
          onClick={onReindex}
          disabled={disabled || executing}
        >
          {executing ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="mr-2 h-3.5 w-3.5" />
          )}
          {t('semantic.actions.reindex')}
        </Button>
      </CardFooter>
    </Card>
  );
}

function ProjectNamespaceStatus({
  scope,
  status,
  requestError,
  executing,
}: {
  scope: ProjectSemanticScope;
  status: SemanticNamespaceStatusView | null;
  requestError: string | null;
  executing: boolean;
}) {
  const { t } = useTranslation('admin');
  const percent = coveragePercent(status);
  const errors = [requestError, status?.last_error].filter(
    (value): value is string => !!value,
  );
  const failed = status?.failed_items ?? 0;
  const errorCount = errors.length + failed;

  if (!status) {
    return (
      <div className="min-w-56 space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t(`semantic.projects.scopes.${scope}`)}
        </p>
        <Badge variant={requestError ? 'destructive' : 'muted'}>
          {requestError
            ? t('semantic.projects.errorCount', { count: 1 })
            : t('semantic.projects.unavailable')}
        </Badge>
        {requestError && (
          <p className="max-w-56 break-words text-[10px] text-destructive">{requestError}</p>
        )}
      </div>
    );
  }

  return (
    <div className="min-w-56 space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t(`semantic.projects.scopes.${scope}`)}
      </p>
      <div className="space-y-0.5 whitespace-nowrap text-[11px]">
        <p>
          {t('semantic.projects.activeGeneration', {
            id: status.active?.generationId ?? '—',
          })}
        </p>
        <p className={status.building && executing ? 'text-info' : 'text-muted-foreground'}>
          {t('semantic.projects.buildingGeneration', {
            id: status.building?.generationId ?? '—',
          })}
        </p>
      </div>
      <div>
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="text-muted-foreground">{t('semantic.projects.metrics.coverage')}</span>
          <span className="tabular-nums">
            {status.expected_items
              ? t('semantic.coverage.value', {
                  indexed: status.indexed_items,
                  total: status.expected_items,
                  percent: Math.round(percent),
                })
              : t('semantic.coverage.waiting')}
          </span>
        </div>
        <Progress
          className="mt-1.5 h-1.5"
          value={percent}
          indeterminate={!!status.building && executing && !status.expected_items}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={status.delta_items > 0 ? 'text-[11px] text-warning' : 'text-[11px] text-muted-foreground'}>
          {t('semantic.projects.metrics.delta', { count: status.delta_items })}
        </span>
        {errorCount > 0 ? (
          <Badge variant="destructive">
            {t('semantic.projects.errorCount', { count: errorCount })}
          </Badge>
        ) : status.active ? (
          <Badge variant="success">{t('semantic.projects.healthy')}</Badge>
        ) : status.building ? (
          <Badge variant={executing ? 'info' : 'warning'}>
            {t(executing ? 'semantic.status.building' : 'semantic.status.pending')}
          </Badge>
        ) : (
          <Badge variant="warning">{t('semantic.projects.notActive')}</Badge>
        )}
      </div>
      {errors[0] && (
        <p className="max-w-56 break-words text-[10px] text-destructive">{errors[0]}</p>
      )}
    </div>
  );
}

function ProjectSemanticStatusTable({
  results,
  globalStorage,
  loading,
  reindexingProjectId,
  codeProfileRunning,
  memoryProfileRunning,
  executingNamespaces,
  codeIndexingDisabled,
  onReindexProject,
}: {
  results: ProjectSemanticStatusResult[];
  globalStorage: SemanticNamespaceStatusView[];
  loading: boolean;
  reindexingProjectId: number | null;
  codeProfileRunning: boolean;
  memoryProfileRunning: boolean;
  executingNamespaces: ReadonlySet<string>;
  codeIndexingDisabled: boolean;
  onReindexProject: (project: ProjectSemanticStatusResult['project']) => void;
}) {
  const { t } = useTranslation('admin');
  const docsNamespaces = new Map<string, SemanticNamespaceStatusView>();
  for (const namespace of globalStorage) {
    if (namespace.namespace.startsWith('docs:')) docsNamespaces.set(namespace.namespace, namespace);
  }
  for (const result of results) {
    for (const namespace of result.status?.namespaces ?? []) {
      if (namespace.namespace.startsWith('docs:')) docsNamespaces.set(namespace.namespace, namespace);
    }
  }
  const docs = [...docsNamespaces.values()];
  const docsPath = docs[0]?.dbPath ?? null;
  const docsSize = docs[0]?.size_bytes ?? 0;
  const docsExpected = docs.reduce((total, namespace) => total + namespace.expected_items, 0);
  const docsIndexed = docs.reduce((total, namespace) => total + namespace.indexed_items, 0);
  const docsFailed = docs.reduce((total, namespace) => total + namespace.failed_items, 0);
  const memory = globalStorage.find((namespace) => namespace.namespace === 'memory:user') ?? null;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">{t('semantic.projects.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('semantic.projects.description')}</p>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1320px] text-left text-xs">
            <thead className="border-b bg-muted/30 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">{t('semantic.projects.columns.project')}</th>
                <th className="px-4 py-3">{t('semantic.projects.columns.database')}</th>
                <th className="px-4 py-3">{t('semantic.projects.columns.size')}</th>
                <th className="px-4 py-3">{t('semantic.projects.scopes.code')}</th>
                <th className="px-4 py-3">{t('semantic.projects.scopes.snapshot')}</th>
                <th className="px-4 py-3">{t('semantic.projects.scopes.project_memory')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {results.map((result) => {
                const scopes = summarizeProjectSemanticScopes(result);
                const storage = summarizeProjectVectorStorage(scopes);
                const codeNamespace = result.status?.namespaces.find(
                  (entry) => entry.namespace === `code:p${result.project.id}`,
                );
                const projectJobStatus = result.status?.reindex_job?.status;
                const projectBuilding = codeProfileRunning
                  || projectJobStatus === 'running';
                return (
                  <tr key={result.project.id} className="align-top">
                    <td className="px-4 py-3">
                      <p className="font-medium">{result.project.name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {t('semantic.projects.projectId', { id: result.project.id })}
                      </p>
                      <Button
                        className="mt-3"
                        variant="outline"
                        size="sm"
                        disabled={codeIndexingDisabled || projectBuilding || reindexingProjectId === result.project.id}
                        onClick={() => onReindexProject(result.project)}
                      >
                        {projectBuilding || reindexingProjectId === result.project.id ? (
                          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="mr-2 h-3.5 w-3.5" />
                        )}
                        {t(codeNamespace?.active
                          ? 'semantic.actions.reindexProject'
                          : 'semantic.actions.indexProject')}
                      </Button>
                    </td>
                    <td className="max-w-sm px-4 py-3">
                      {storage.dbPaths.length > 0 ? (
                        storage.dbPaths.map((dbPath) => (
                          <p key={dbPath} className="break-all font-mono text-[11px] text-muted-foreground">
                            {dbPath}
                          </p>
                        ))
                      ) : (
                        <p className="text-muted-foreground">{t('semantic.projects.unavailable')}</p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-medium tabular-nums">
                      {storage.dbPaths.length > 0 ? formatBytes(storage.sizeBytes) : '—'}
                    </td>
                    {scopes.map((scope) => (
                      <td key={scope.scope} className="px-4 py-3">
                        <ProjectNamespaceStatus
                          scope={scope.scope}
                          status={scope.status}
                          requestError={result.error
                            ?? (scope.scope === 'code' ? result.status?.reindex_job?.error ?? null : null)}
                          executing={scope.scope === 'code'
                            ? projectBuilding
                            : memoryProfileRunning
                              || (!!scope.status && executingNamespaces.has(scope.status.namespace))}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
              {!loading && results.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    {t('semantic.projects.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && results.length === 0 && (
          <div className="flex items-center justify-center border-t px-4 py-8 text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('semantic.projects.loading')}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">{t('semantic.global.title')}</CardTitle>
          <CardDescription>{t('semantic.global.description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border bg-muted/10 p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold">{t('semantic.global.docs')}</p>
              {docsPath && <Badge variant="info">{formatBytes(docsSize)}</Badge>}
            </div>
            <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
              {docsPath ?? t('semantic.global.docsUnavailable')}
            </p>
            {docsPath && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                {t('semantic.global.coverage', {
                  indexed: docsIndexed,
                  total: docsExpected,
                  failed: docsFailed,
                })}
              </p>
            )}
          </div>
          <div className="rounded-lg border border-dashed bg-muted/10 p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold">{t('semantic.global.memory')}</p>
              {memory && <Badge variant="info">{formatBytes(memory.size_bytes)}</Badge>}
            </div>
            <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
              {memory?.dbPath ?? t('semantic.global.memoryUnavailable')}
            </p>
            {memory && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>
                  {t('semantic.global.coverage', {
                    indexed: memory.indexed_items,
                    total: memory.expected_items,
                    failed: memory.failed_items,
                  })}
                </span>
                <Badge variant={memory.active
                  ? 'success'
                  : memory.building && (memoryProfileRunning || executingNamespaces.has(memory.namespace))
                    ? 'info'
                    : memory.building
                      ? 'warning'
                      : 'muted'}>
                  {memory.active
                    ? t('semantic.projects.activeGeneration', {
                        id: memory.active.generationId,
                      })
                    : memory.building && (memoryProfileRunning || executingNamespaces.has(memory.namespace))
                      ? t('semantic.projects.buildingGeneration', {
                          id: memory.building.generationId,
                        })
                      : memory.building
                        ? t('semantic.status.pending')
                      : t('semantic.projects.notActive')}
                </Badge>
              </div>
            )}
            {memory?.last_error && (
              <p className="mt-2 break-words text-[11px] text-destructive">{memory.last_error}</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function SemanticIndexingPanel() {
  const { t } = useTranslation('admin');
  const [profiles, setProfiles] = useState<SemanticProfileView[]>([]);
  const [generations, setGenerations] = useState<SemanticGenerationView[]>([]);
  const [jobs, setJobs] = useState<SemanticJobView[]>([]);
  const [globalStorage, setGlobalStorage] = useState<SemanticNamespaceStatusView[]>([]);
  const [rerankers, setRerankers] = useState<Record<
    SemanticProfilePurpose,
    SemanticRerankerStatusView
  >>({
    code: { target_kind: 'missing', diagnostics: null, error: null },
    docs: { target_kind: 'missing', diagnostics: null, error: null },
    memory: { target_kind: 'missing', diagnostics: null, error: null },
  });
  const [providers, setProviders] = useState<AdminProvider[]>([]);
  const [projectStatuses, setProjectStatuses] = useState<ProjectSemanticStatusResult[]>([]);
  const [editing, setEditing] = useState<SemanticProfileView | null>(null);
  const [reindexing, setReindexing] = useState<SemanticProfilePurpose | null>(null);
  const [reindexingProjectId, setReindexingProjectId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cleaningUnused, setCleaningUnused] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<SemanticUnusedVectorCleanupResult | null>(null);

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const [nextProfiles, nextSemanticState, nextProviders, nextProjectStatuses] = await Promise.all([
        fetchSemanticProfiles(),
        fetchSemanticGenerations(),
        fetchProviders(),
        fetchProjectSemanticStatuses(),
      ]);
      setProfiles(nextProfiles);
      setGenerations(nextSemanticState.generations);
      setJobs(nextSemanticState.jobs);
      setGlobalStorage(nextSemanticState.storage);
      setRerankers(nextSemanticState.rerankers);
      setProviders(nextProviders);
      setProjectStatuses(nextProjectStatuses);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const purposeJobs = useMemo(() => Object.fromEntries(PURPOSES.map((purpose) => [
    purpose,
    latestPurposeJob(purpose, jobs, generations),
  ])) as Record<SemanticProfilePurpose, SemanticJobView | null>, [jobs, generations]);
  const executingNamespaces = useMemo(() => new Set(
    jobs.filter(isExecutingSemanticJob).map((job) => job.namespace),
  ), [jobs]);
  // Physical `building` pointers survive a crash so a later explicit request
  // can resume atomically. They are not proof that work is consuming CPU.
  // Poll only while the durable queue says a worker is actually executing (or
  // an explicit control marker is waiting for its same-turn microtask).
  const shouldPoll = reindexing !== null || jobs.some(isExecutingSemanticJob);
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(() => void load(false), 3_000);
    return () => window.clearInterval(timer);
  }, [shouldPoll, load]);

  const visibleProfiles = PURPOSES.map(
    (purpose) => profiles.find((profile) => profile.purpose === purpose) ?? fallbackProfile(purpose),
  );

  async function startReindex(purpose: SemanticProfilePurpose) {
    if (!(await confirmDialog({
      title: t('semantic.actions.reindex'),
      description: t('semantic.actions.reindexConfirm', {
        purpose: t(`semantic.purpose.${purpose}.title`),
      }),
      confirmLabel: t('semantic.actions.reindex'),
      tone: 'destructive',
    }))) {
      return;
    }
    setReindexing(purpose);
    setError(null);
    try {
      await reindexSemanticProfile(purpose);
      await load(false);
    } catch (reindexError) {
      setError(reindexError instanceof Error ? reindexError.message : String(reindexError));
    } finally {
      setReindexing(null);
    }
  }

  async function startProjectReindex(project: ProjectSemanticStatusResult['project']) {
    if (!(await confirmDialog({
      title: t('semantic.actions.reindexProject'),
      description: t('semantic.actions.reindexProjectConfirm', { project: project.name }),
      confirmLabel: t('semantic.actions.reindexProject'),
      tone: 'destructive',
    }))) {
      return;
    }
    setReindexingProjectId(project.id);
    setError(null);
    try {
      await reindexProjectSemanticCode(project.id);
      await load(false);
    } catch (reindexError) {
      setError(reindexError instanceof Error ? reindexError.message : String(reindexError));
    } finally {
      setReindexingProjectId(null);
    }
  }

  async function cleanupUnusedVectors() {
    if (!(await confirmDialog({
      title: t('semantic.actions.cleanupUnused'),
      description: t('semantic.actions.cleanupUnusedConfirm'),
      confirmLabel: t('semantic.actions.cleanupUnused'),
      tone: 'destructive',
    }))) return;
    setCleaningUnused(true);
    setCleanupResult(null);
    setError(null);
    try {
      const result = await cleanupUnusedSemanticVectors();
      setCleanupResult(result);
      const description = t('semantic.cleanup.resultDescription', {
        tables: result.tables_removed,
        items: result.items_removed,
        databases: result.databases_compacted,
        bytes: formatBytes(result.bytes_reclaimed),
        skipped: result.skipped_referenced,
      });
      if (result.failures.length > 0) {
        toast.warning(t('semantic.cleanup.resultTitle'), {
          description: `${description} ${t('semantic.cleanup.failureCount', {
            count: result.failures.length,
          })}`,
        });
      } else {
        toast.success(t('semantic.cleanup.resultTitle'), { description });
      }
      await load(false);
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      setError(message);
      toast.error(t('semantic.loadError'), { description: message });
    } finally {
      setCleaningUnused(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Database className="h-5 w-5" />
            {t('semantic.title')}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t('semantic.description')}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void cleanupUnusedVectors()}
            disabled={cleaningUnused || loading || reindexing !== null || jobs.some(isExecutingSemanticJob)}
          >
            {cleaningUnused ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" />
            )}
            {t('semantic.actions.cleanupUnused')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || cleaningUnused}>
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {t('semantic.actions.refresh')}
          </Button>
        </div>
      </div>

      <Alert variant="info">
        <HardDrive />
        <AlertTitle>{t('semantic.localOnly.title')}</AlertTitle>
        <AlertDescription>{t('semantic.localOnly.description')}</AlertDescription>
      </Alert>

      <Alert>
        <Sparkles />
        <AlertTitle>{t('semantic.onDemand.title')}</AlertTitle>
        <AlertDescription>{t('semantic.onDemand.description')}</AlertDescription>
      </Alert>

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{t('semantic.loadError')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {cleanupResult && (
        <Alert variant={cleanupResult.failures.length > 0 ? 'warning' : 'success'}>
          <HardDrive />
          <AlertTitle>{t('semantic.cleanup.resultTitle')}</AlertTitle>
          <AlertDescription>
            {t('semantic.cleanup.resultDescription', {
              tables: cleanupResult.tables_removed,
              items: cleanupResult.items_removed,
              databases: cleanupResult.databases_compacted,
              bytes: formatBytes(cleanupResult.bytes_reclaimed),
              skipped: cleanupResult.skipped_referenced,
            })}
            {cleanupResult.failures.length > 0
              ? ` ${t('semantic.cleanup.failureCount', { count: cleanupResult.failures.length })}`
              : ''}
          </AlertDescription>
        </Alert>
      )}

      {loading && profiles.length === 0 ? (
        <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          {t('semantic.loading')}
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-3">
          {visibleProfiles.map((profile) => (
            <ProfileCard
              key={profile.purpose}
              profile={profile}
              generation={latestGeneration(profile.purpose, generations)}
              job={purposeJobs[profile.purpose]}
              rerankerStatus={rerankers[profile.purpose]}
              providers={providers}
              reindexing={reindexing === profile.purpose}
              onEdit={() => setEditing(profile)}
              onReindex={() => void startReindex(profile.purpose)}
            />
          ))}
        </div>
      )}

      <ProjectSemanticStatusTable
        results={projectStatuses}
        globalStorage={globalStorage}
        loading={loading}
        reindexingProjectId={reindexingProjectId}
        codeProfileRunning={!!purposeJobs.code && isExecutingSemanticJob(purposeJobs.code)}
        memoryProfileRunning={jobs.some((job) =>
          job.namespace === 'semantic:reindex:memory' && isExecutingSemanticJob(job))}
        executingNamespaces={executingNamespaces}
        codeIndexingDisabled={visibleProfiles.find((profile) => profile.purpose === 'code')
          ?.embedding_target.kind === 'disabled'}
        onReindexProject={(project) => void startProjectReindex(project)}
      />

      {editing && (
        <ProfileDialog
          profile={editing}
          providers={providers}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setProfiles((current) => [
              ...current.filter((profile) => profile.purpose !== saved.purpose),
              saved,
            ]);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
