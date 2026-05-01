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
  testResult: TestResult | undefined;
  refreshing: boolean;
  onTest: () => void;
  onToggleExpand: () => void;
  onRefresh: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onToggleModel: (modelId: string, mode: string, enabled: boolean) => void;
  onSetFallback: (providerId: string, fallbackProviderId: string | null) => void;
}

export function ProviderCard({
  provider: p,
  allProviders,
  isExpanded,
  models,
  testResult: tr,
  refreshing,
  onTest,
  onToggleExpand,
  onRefresh,
  onEdit,
  onRemove,
  onToggleModel,
  onSetFallback,
}: ProviderCardProps) {
  const { t } = useTranslation(['admin', 'common']);
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
                  <Switch
                    checked={m.enabled}
                    onCheckedChange={(v) => onToggleModel(m.model_id, m.mode, v)}
                  />
                </div>
              ))}
            </div>
          )}
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
