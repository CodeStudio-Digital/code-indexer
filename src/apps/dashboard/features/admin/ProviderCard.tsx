import { CheckCircle2, Loader2, RefreshCw, Trash2, XCircle, Zap } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Switch } from '../../components/ui/switch.js';
import type { AdminModel, AdminProvider, TestResult } from './types.js';

interface ProviderCardProps {
  provider: AdminProvider;
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
}

export function ProviderCard({
  provider: p,
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
}: ProviderCardProps) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <CardTitle className="text-base truncate">{p.name}</CardTitle>
            <Badge variant="outline">{p.kind}</Badge>
            {p.is_default && <Badge>default</Badge>}
            {!p.enabled && <Badge variant="secondary">disabled</Badge>}
            {p.has_key ? (
              <span className="text-xs text-muted-foreground font-mono">{p.api_key_masked}</span>
            ) : (
              <span className="text-xs text-amber-600">no key</span>
            )}
            {tr &&
              (tr.ok ? (
                <span className="flex items-center gap-1 text-xs text-emerald-600">
                  <CheckCircle2 className="h-3 w-3" /> {tr.latencyMs}ms
                </span>
              ) : tr.error === 'testing…' ? (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              ) : (
                <span className="flex items-center gap-1 text-xs text-red-600" title={tr.error}>
                  <XCircle className="h-3 w-3" /> fail
                </span>
              ))}
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={onTest}>
              <Zap className="h-4 w-4 mr-1" /> Test
            </Button>
            <Button size="sm" variant="ghost" onClick={onToggleExpand}>
              Models ({models.length || '…'})
            </Button>
            <Button size="sm" variant="ghost" onClick={onRefresh} disabled={refreshing}>
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
            <Button size="sm" variant="ghost" onClick={onEdit}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={onRemove}>
              <Trash2 className="h-4 w-4 text-red-600" />
            </Button>
          </div>
        </div>
      </CardHeader>
      {isExpanded && (
        <CardContent className="pt-0 border-t bg-muted/20">
          {models.length === 0 ? (
            <div className="py-3 text-sm text-muted-foreground">
              No models yet. Click refresh to fetch from the provider API.
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
        </CardContent>
      )}
    </Card>
  );
}
