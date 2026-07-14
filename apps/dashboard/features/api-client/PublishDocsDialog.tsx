/**
 * Publish a collection as a hosted API docs page (the P1 "wedge"). Exports the
 * active collection to OpenAPI via the LOCAL http-api, then hands it to the cloud
 * worker (`docs.publish`), which re-redacts + signs + stores it and returns a
 * shareable `/d/:slug` link. Also lists + revokes the account's existing docs.
 * All cloud calls are entitlement-gated server-side (apiDocs); a free/anon caller
 * gets a typed error surfaced inline.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe, Copy, ExternalLink, Trash2, Loader2, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';
import { confirm } from '../../components/ui/prompt-dialog.js';
import { UpgradeNotice } from '../../components/UpgradeNotice.js';
import { useEntitlements } from '../account/useEntitlements.js';
import { cloudCall } from '../../lib/cloud/cloud-client.js';
import { useCloudAction } from '../../lib/cloud/use-cloud-action.js';
import { ApiClientSelect } from './ApiClientSelect.js';
import * as api from './api.js';

interface DocSummary {
  id: string;
  slug: string;
  title: string;
  visibility: 'public' | 'unlisted';
  status: 'active' | 'revoked';
  tryItMode: 'off' | 'local';
  operationCount: number;
}

function openExternal(url: string): void {
  (globalThis as { electronAPI?: { openExternal?: (u: string) => void } }).electronAPI?.openExternal?.(url);
}

interface Props {
  collectionId: number | null;
  collectionName: string;
  projectId: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function PublishDocsDialog({ collectionId, collectionName, projectId, open, onOpenChange }: Props) {
  const { t } = useTranslation('apiClient');
  const { has } = useEntitlements();
  const { busy, error, run, setError } = useCloudAction();
  const [visibility, setVisibility] = useState<'unlisted' | 'public'>('unlisted');
  const [tryItMode, setTryItMode] = useState<'off' | 'local'>('off');
  const [result, setResult] = useState<{ url: string; redactionCount: number } | null>(null);
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [baseUrl, setBaseUrl] = useState('');
  const [copied, setCopied] = useState(false);

  const loadList = useCallback(async () => {
    const r = await cloudCall('docs.list', undefined);
    setDocs(r.docs as DocSummary[]);
    setBaseUrl(r.baseUrl);
  }, []);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setCopied(false);
    setError(null);
    void run(loadList);
  }, [open, run, loadList, setError]);

  const publish = () =>
    run(async () => {
      if (collectionId == null) {
        setError(t('hostedDocs.selectCollectionFirst'));
        return;
      }
      const spec = await api.exportCollection(projectId, collectionId, 'openapi');
      const r = await cloudCall('docs.publish', { title: collectionName, spec, visibility, tryItMode });
      setResult({ url: r.url, redactionCount: r.redactionCount });
      await loadList();
    });

  const revoke = (d: DocSummary) =>
    run(async () => {
      if (!(await confirm({ title: t('hostedDocs.revokeConfirmTitle'), description: t('hostedDocs.revokeConfirmBody'), tone: 'destructive' }))) return;
      await cloudCall('docs.revoke', { id: d.id });
      await loadList();
    });

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — non-fatal */
    }
  };

  const urlFor = (slug: string) => `${baseUrl}/d/${slug}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Globe className="h-4 w-4" /> {t('hostedDocs.title')}</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">{t('hostedDocs.subtitle')}</p>
        {!has('apiDocs') ? <UpgradeNotice message={t('hostedDocs.upgradeMsg')} cta={t('hostedDocs.upgradeCta')} /> : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs space-y-1">
            <span className="text-muted-foreground">{t('hostedDocs.visibility')}</span>
            <ApiClientSelect
              value={visibility}
              onValueChange={(value) => setVisibility(value as 'unlisted' | 'public')}
              options={[
                { value: 'unlisted', label: t('hostedDocs.visibilityUnlisted') },
                { value: 'public', label: t('hostedDocs.visibilityPublic') },
              ]}
              ariaLabel={t('hostedDocs.visibility')}
            />
          </label>
          <label className="text-xs space-y-1">
            <span className="text-muted-foreground">{t('hostedDocs.tryIt')}</span>
            <ApiClientSelect
              value={tryItMode}
              onValueChange={(value) => setTryItMode(value as 'off' | 'local')}
              options={[
                { value: 'off', label: t('hostedDocs.tryItOff') },
                { value: 'local', label: t('hostedDocs.tryItLocal') },
              ]}
              ariaLabel={t('hostedDocs.tryIt')}
            />
          </label>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" disabled={busy || collectionId == null} onClick={() => void publish()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />} {t('hostedDocs.publish')}
          </Button>
          {collectionId == null ? <span className="text-xs text-muted-foreground">{t('hostedDocs.selectCollectionFirst')}</span> : null}
        </div>

        {result ? (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
            <div className="text-xs font-medium text-emerald-600">{t('hostedDocs.published')}</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate text-[11px] font-mono bg-background rounded px-2 py-1 border">{result.url}</code>
              <Button size="icon" variant="ghost" className="h-7 w-7" title={t('hostedDocs.copyLink')} onClick={() => void copy(result.url)}>
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7" title={t('hostedDocs.open')} onClick={() => openExternal(result.url)}>
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </div>
            {result.redactionCount > 0 ? <div className="text-[11px] text-amber-600">{t('hostedDocs.redactionNote', { count: result.redactionCount })}</div> : null}
          </div>
        ) : null}

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">{t('hostedDocs.existing')}</div>
          {docs.filter((d) => d.status === 'active').length === 0 ? (
            <p className="text-xs text-muted-foreground py-2 text-center">{t('hostedDocs.empty')}</p>
          ) : (
            <div className="max-h-[40vh] overflow-auto border rounded-md divide-y divide-border/40">
              {docs.filter((d) => d.status === 'active').map((d) => (
                <div key={d.id} className="group flex items-center gap-2 px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{d.title}</div>
                    <div className="text-[11px] text-muted-foreground">{t('hostedDocs.operations', { count: d.operationCount })} · {d.visibility}</div>
                  </div>
                  <Button size="icon" variant="ghost" className="h-7 w-7" title={t('hostedDocs.copyLink')} onClick={() => void copy(urlFor(d.slug))}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" title={t('hostedDocs.open')} onClick={() => openExternal(urlFor(d.slug))}>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 hover:text-red-500" title={t('hostedDocs.revoke')} onClick={() => void revoke(d)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
