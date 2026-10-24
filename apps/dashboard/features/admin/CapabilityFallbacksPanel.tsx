import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RefreshCw, Search } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import {
  fetchCapabilityFallbacks,
  previewCapabilityResolution,
  type CapabilityFallbackEvent,
  type ResolveCapabilityResponse,
} from './api.js';

/**
 * Phase G — surfaces the in-memory list of models that have resolved
 * via the family heuristic (`inferred`) or the hardcoded 128K fallback
 * (`fallback`) since the server booted. Operators use this to decide
 * whether to lock in explicit `context_window` values on those models
 * via the existing inline editor on ProviderCard.
 *
 * Also exposes a tiny "preview resolution" widget — type any model
 * name and see what window the chain would pick. Useful before adding
 * a new model manually.
 */
export function CapabilityFallbacksPanel(): JSX.Element {
  const { t } = useTranslation('admin');
  const [items, setItems] = useState<CapabilityFallbackEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewModel, setPreviewModel] = useState('');
  const [preview, setPreview] = useState<ResolveCapabilityResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await fetchCapabilityFallbacks());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handlePreview = useCallback(async () => {
    const m = previewModel.trim();
    if (!m) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      setPreview(await previewCapabilityResolution(m));
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [previewModel]);

  const fmtWindow = (n: number): string => `${(n / 1000).toFixed(0)}k`;
  const fmtTime = (ms: number): string => new Date(ms).toLocaleString();

  const inferredCount = items.filter((i) => i.source === 'inferred').length;
  const fallbackCount = items.filter((i) => i.source === 'fallback').length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-base font-semibold">{t('capabilityFallbacks.title')}</h3>
          <p className="text-sm text-muted-foreground">
            {t('capabilityFallbacks.description.before')}
            <code className="mx-1 px-1 bg-muted rounded">context_window</code>
            {t('capabilityFallbacks.description.after')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          {t('capabilityFallbacks.reload')}
        </Button>
      </div>

      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Badge variant="secondary">{t('capabilityFallbacks.total', { count: items.length })}</Badge>
        <Badge variant="secondary">{t('capabilityFallbacks.inferred', { count: inferredCount })}</Badge>
        <Badge variant={fallbackCount > 0 ? 'destructive' : 'secondary'}>
          {t('capabilityFallbacks.fallback', { count: fallbackCount })}
        </Badge>
      </div>

      {/* Preview widget */}
      <div className="border rounded-md p-3 space-y-2">
        <div className="text-sm font-medium">{t('capabilityFallbacks.previewTitle')}</div>
        <div className="flex gap-2">
          <Input
            value={previewModel}
            onChange={(e) => setPreviewModel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handlePreview(); }}
            placeholder="e.g. claude-sonnet-5-experimental, gpt-6, gemini-3-pro"
            className="flex-1"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handlePreview()}
            disabled={previewLoading || !previewModel.trim()}
          >
            <Search className="h-4 w-4 mr-2" />
            {t('capabilityFallbacks.resolve')}
          </Button>
        </div>
        {previewError && (
          <div className="text-sm text-destructive flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" /> {previewError}
          </div>
        )}
        {preview && (
          <div className="text-sm space-y-1 pt-2 border-t">
            <div>
              <span className="text-muted-foreground">{t('capabilityFallbacks.staticChain')}</span>{' '}
              <Badge variant={preview.static.source === 'fallback' ? 'destructive' : 'secondary'}>
                {preview.static.source}
              </Badge>{' '}
              <span className="font-mono">{fmtWindow(preview.static.window)}</span>{' '}
              <span className="text-muted-foreground">{t('capabilityFallbacks.via')}</span>{' '}
              <code className="text-xs">{preview.static.via}</code>
            </div>
            <div>
              <span className="text-muted-foreground">{t('capabilityFallbacks.runtime')}</span>{' '}
              <Badge variant={preview.runtime.source === 'fallback' ? 'destructive' : 'secondary'}>
                {preview.runtime.source}
              </Badge>{' '}
              <span className="font-mono">{fmtWindow(preview.runtime.window)}</span>{' '}
              <span className="text-muted-foreground">
                {t('capabilityFallbacks.effective', {
                  effective: fmtWindow(preview.runtime.effective),
                  reserved: fmtWindow(preview.runtime.reservedOutput),
                })}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Recent fallbacks list */}
      {items.length === 0 ? (
        <div className="text-sm text-muted-foreground italic py-6 text-center border rounded-md">
          {loading ? t('capabilityFallbacks.loading') : t('capabilityFallbacks.empty')}
        </div>
      ) : (
        <div className="border rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">{t('capabilityFallbacks.columns.model')}</th>
                <th className="px-3 py-2 text-left">{t('capabilityFallbacks.columns.source')}</th>
                <th className="px-3 py-2 text-left">{t('capabilityFallbacks.columns.via')}</th>
                <th className="px-3 py-2 text-right">{t('capabilityFallbacks.columns.window')}</th>
                <th className="px-3 py-2 text-right">{t('capabilityFallbacks.columns.hits')}</th>
                <th className="px-3 py-2 text-left">{t('capabilityFallbacks.columns.lastSeen')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.model} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{it.model}</td>
                  <td className="px-3 py-2">
                    <Badge variant={it.source === 'fallback' ? 'destructive' : 'secondary'}>
                      {it.source}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{it.via}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmtWindow(it.window)}</td>
                  <td className="px-3 py-2 text-right">{it.count}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{fmtTime(it.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
