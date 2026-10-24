import { fetchSemanticModels, type SemanticModelView, type SemanticOnnxDtype, type SemanticTarget, type SemanticTargetKind } from './semantic-api.js';
import type { AdminProvider } from './types.js';
import { useTranslation } from 'react-i18next';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../components/ui/badge.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select.js';
import { Input } from '../../components/ui/input.js';
import { Loader2 } from 'lucide-react';
import { Switch } from '../../components/ui/switch.js';
import { targetModel, modelId, isLoopbackUrl, targetForKind } from './semantic-indexing-format.js';

interface TargetEditorProps {
  capability: 'embedding' | 'rerank';
  target: SemanticTarget;
  providers: AdminProvider[];
  onChange: (target: SemanticTarget) => void;
}

export function TargetEditor({ capability, target, providers, onChange }: TargetEditorProps) {
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
