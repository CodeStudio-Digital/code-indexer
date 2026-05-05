import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Loader2, RefreshCw, Trash2, XCircle, Zap } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Switch } from '../../components/ui/switch.js';
import { ClaudeCodeUsagePanel } from './ClaudeCodeUsagePanel.js';
import { GoogleQuotaPanel } from './GoogleQuotaPanel.js';
import { FallbackChainPanel } from './FallbackChainPanel.js';
import type { AdminModel, AdminProvider, TestResult } from './types.js';

interface ProviderCardProps {
  provider: AdminProvider;
  allProviders: AdminProvider[];
  isExpanded: boolean;
  models: AdminModel[];
  providerModelsById: Record<string, AdminModel[]>;
  testResult: TestResult | undefined;
  refreshing: boolean;
  onTest: () => void;
  onToggleExpand: () => void;
  onLoadProviderModels: (providerId: string) => void | Promise<void>;
  onRefresh: () => void;
  onEdit: () => void;
  onConnect?: () => void;
  onRemove: () => void;
  onToggleModel: (modelId: string, mode: string, enabled: boolean) => void;
  onSetModelEffort: (modelId: string, mode: string, level: string | null) => void;
  onSetFallback: (providerId: string, fallbackProviderId: string | null) => void;
  onSetSubagentTarget: (
    providerId: string,
    subagentProviderId: string | null,
    modelId: string | null,
  ) => void;
  onSetKimiCodeThinkingMode: (providerId: string, mode: 'auto' | 'enabled' | 'disabled') => void;
}

export function ProviderCard({
  provider: p,
  allProviders,
  isExpanded,
  models,
  providerModelsById,
  testResult: tr,
  refreshing,
  onTest,
  onToggleExpand,
  onLoadProviderModels,
  onRefresh,
  onEdit,
  onConnect,
  onRemove,
  onToggleModel,
  onSetModelEffort,
  onSetFallback,
  onSetSubagentTarget,
  onSetKimiCodeThinkingMode,
}: ProviderCardProps) {
  const { t } = useTranslation(['admin', 'common']);
  const selectedSubagentProviderId = readSubagentProviderId(p.extra?.subagent_provider_id);
  const subagentTargetProviderId = selectedSubagentProviderId ?? p.id;
  const subagentModels = providerModelsById[subagentTargetProviderId] ?? (
    subagentTargetProviderId === p.id ? models : []
  );
  const selectedSubagentModelId = readSubagentModelId(p.extra?.subagent_model);
  const enabledSubagentProviderOptions = allProviders.filter((candidate) => (
    candidate.id !== p.id && candidate.enabled && candidate.use_for_coder
  ));
  const selectedSubagentProvider = selectedSubagentProviderId
    ? allProviders.find((candidate) => candidate.id === selectedSubagentProviderId)
    : null;
  const subagentProviderOptions =
    selectedSubagentProvider &&
    !enabledSubagentProviderOptions.some((candidate) => candidate.id === selectedSubagentProvider.id)
      ? [selectedSubagentProvider, ...enabledSubagentProviderOptions]
      : enabledSubagentProviderOptions;
  const enabledSubagentModels = subagentModels.filter((m) => m.enabled);
  const selectedSubagentModelMissing = !!selectedSubagentModelId &&
    !enabledSubagentModels.some((m) => m.model_id === selectedSubagentModelId);

  useEffect(() => {
    if (!isExpanded || providerModelsById[subagentTargetProviderId]) return;
    void onLoadProviderModels(subagentTargetProviderId);
  }, [isExpanded, onLoadProviderModels, providerModelsById, subagentTargetProviderId]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <CardTitle className="text-base truncate">{p.name}</CardTitle>
            <Badge variant="outline">{p.kind}</Badge>
            {p.is_default && <Badge>{t('admin:provider.default')}</Badge>}
            {!p.enabled && <Badge variant="secondary">{t('admin:provider.disabled')}</Badge>}
            {p.has_key ? (
              <span className="text-xs text-muted-foreground font-mono">{p.api_key_masked}</span>
            ) : (
              <span className="text-xs text-amber-600">{t('admin:provider.noKey')}</span>
            )}
            {tr &&
              (tr.ok ? (
                <span className="flex items-center gap-1 text-xs text-emerald-600">
                  <CheckCircle2 className="h-3 w-3" /> {tr.latencyMs}ms
                </span>
              ) : tr.error === t('admin:provider.testing') ? (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              ) : (
                <span className="flex items-center gap-1 text-xs text-red-600" title={tr.error}>
                  <XCircle className="h-3 w-3" /> {t('admin:provider.fail')}
                </span>
              ))}
          </div>
          <div className="flex items-center gap-1.5">
            {onConnect && (
              <Button size="sm" variant="ghost" onClick={onConnect}>
                {t('admin:provider.connect')}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onTest}>
              <Zap className="h-4 w-4 mr-1" /> {t('common:actions.test')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onToggleExpand}>
              {t('admin:provider.models', { count: models.length || '…' })}
            </Button>
            <Button size="sm" variant="ghost" onClick={onRefresh} disabled={refreshing}>
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
            <Button size="sm" variant="ghost" onClick={onEdit}>
              {t('common:actions.edit')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onRemove}>
              <Trash2 className="h-4 w-4 text-red-600" />
            </Button>
          </div>
        </div>
      </CardHeader>
      {isExpanded && (
        <CardContent className="pt-0 border-t bg-muted/20">
          {p.kind === 'google-oauth' && (
            <GoogleQuotaPanel providerId={p.id} />
          )}
          {p.kind === 'claude-code' && (
            <ClaudeCodeUsagePanel providerId={p.id} />
          )}
          {p.kind === 'kimi-code' && (
            <div className="flex items-center justify-between py-3">
              <label className="text-sm font-medium">
                {t('admin:provider.kimiThinking')}
              </label>
              <select
                aria-label="Kimi Code thinking mode"
                className="h-7 rounded border bg-background px-1.5 text-xs"
                value={readKimiThinkingMode(p.extra?.kimi_code_thinking_mode)}
                onChange={(e) =>
                  onSetKimiCodeThinkingMode(
                    p.id,
                    readKimiThinkingMode(e.target.value),
                  )
                }
              >
                <option value="auto">{t('admin:provider.kimiThinking.auto')}</option>
                <option value="enabled">{t('admin:provider.kimiThinking.enabled')}</option>
                <option value="disabled">{t('admin:provider.kimiThinking.disabled')}</option>
              </select>
            </div>
          )}
          {models.length === 0 ? (
            <div className="py-3 text-sm text-muted-foreground">
              {t('admin:provider.noModels')}
            </div>
          ) : (
            <div className="divide-y">
              {models.map((m) => (
                <div
                  key={`${m.model_id}:${m.mode}`}
                  className="flex items-center justify-between py-2 text-sm"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono truncate">{m.model_id}</span>
                    {m.mode && <Badge variant="outline">{m.mode}</Badge>}
                    <Badge variant="secondary" className="text-[10px]">
                      {m.source}
                    </Badge>
                    <span className="text-xs text-muted-foreground truncate">{m.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {m.supported_reasoning_levels &&
                      m.supported_reasoning_levels.length > 0 && (
                        <select
                          aria-label={`Reasoning effort for ${m.model_id}`}
                          className="h-7 rounded border bg-background px-1.5 text-xs"
                          value={m.default_reasoning_level ?? ''}
                          onChange={(e) =>
                            onSetModelEffort(
                              m.model_id,
                              m.mode,
                              e.target.value === '' ? null : e.target.value,
                            )
                          }
                        >
                          <option value="">auto</option>
                          {m.supported_reasoning_levels.map((lv) => {
                            const label = typeof lv === 'string' ? lv : (lv as Record<string, unknown>)?.effort ?? String(lv);
                            return (
                              <option key={label} value={label}>
                                {label}
                              </option>
                            );
                          })}
                        </select>
                      )}
                    <Switch
                      checked={m.enabled}
                      onCheckedChange={(v) => onToggleModel(m.model_id, m.mode, v)}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* Default subagent provider/model */}
          <div className="pt-3 mt-3 border-t">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-sm font-medium">
                <span>{t('admin:provider.subagentProvider')}</span>
                <select
                  aria-label="Default subagent provider"
                  className="h-8 rounded border bg-background px-2 text-xs"
                  value={selectedSubagentProviderId ?? ''}
                  onChange={(e) => {
                    const nextProviderId = e.target.value === '' ? null : e.target.value;
                    onSetSubagentTarget(p.id, nextProviderId, null);
                    if (nextProviderId && !providerModelsById[nextProviderId]) {
                      void onLoadProviderModels(nextProviderId);
                    }
                  }}
                >
                  <option value="">{t('admin:provider.subagentProviderDefault')}</option>
                  {subagentProviderOptions.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm font-medium">
                <span>{t('admin:provider.subagentModel')}</span>
                <select
                  aria-label="Default subagent model"
                  className="h-8 rounded border bg-background px-2 text-xs"
                  value={selectedSubagentModelId ?? ''}
                  onChange={(e) =>
                    onSetSubagentTarget(
                      p.id,
                      selectedSubagentProviderId,
                      e.target.value === '' ? null : e.target.value,
                    )
                  }
                >
                  <option value="">{t('admin:provider.subagentModelDefault')}</option>
                  {selectedSubagentModelMissing && (
                    <option value={selectedSubagentModelId}>{selectedSubagentModelId}</option>
                  )}
                  {enabledSubagentModels.map((m) => (
                    <option key={`${m.provider_id}:${m.model_id}:${m.mode}`} value={m.model_id}>
                      {m.name || m.model_id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          {/* Fallback chain configuration */}
          <div className="pt-3 mt-3 border-t">
            <FallbackChainPanel
              provider={p}
              allProviders={allProviders}
              onSetFallback={onSetFallback}
            />
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function readKimiThinkingMode(value: unknown): 'auto' | 'enabled' | 'disabled' {
  return value === 'enabled' || value === 'disabled' || value === 'auto'
    ? value
    : 'auto';
}

function readSubagentProviderId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readSubagentModelId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
