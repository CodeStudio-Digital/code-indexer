import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, GitFork, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GitHubAppInstallationPublic } from '@mcp/api-bus';
import { Button } from '../../components/ui/button.js';
import { cloudCall } from '../../lib/cloud/cloud-client.js';

interface State {
  configured: boolean;
  host: string;
  appSlug: string;
  installations: GitHubAppInstallationPublic[];
}

function openExternal(url: string): void {
  (globalThis as { electronAPI?: { openExternal?: (value: string) => void } }).electronAPI?.openExternal?.(url);
}

export function GitHubConnectionsSection() {
  const { t } = useTranslation('cloud');
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState<'load' | 'connect' | number | null>('load');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy((value) => value === 'connect' || typeof value === 'number' ? value : 'load');
    try {
      setState(await cloudCall('github.installations', undefined));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy((value) => value === 'load' ? null : value);
    }
  }, []);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const connect = async () => {
    setBusy('connect');
    setError(null);
    try {
      const { url } = await cloudCall('github.connect', undefined);
      openExternal(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (installationId: number) => {
    setBusy(installationId);
    setError(null);
    try {
      await cloudCall('github.disconnect', { installationId });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="rounded-md border bg-muted/30 p-2"><GitFork className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t('github.title')}</p>
          <p className="text-xs text-muted-foreground">{t('github.description')}</p>
        </div>
        <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void load()}>
          <RefreshCw className={busy === 'load' ? 'mr-1.5 h-3.5 w-3.5 animate-spin' : 'mr-1.5 h-3.5 w-3.5'} />
          {t('github.refresh')}
        </Button>
      </div>

      {state && !state.configured ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          {t('github.unconfigured')}
        </p>
      ) : null}

      <div className="space-y-2">
        {state?.installations.map((installation) => (
          <div key={installation.installationId} className="flex items-center gap-3 rounded-md border p-3">
            <GitFork className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{installation.githubAccountLogin}</p>
              <p className="text-xs text-muted-foreground">
                {installation.githubAccountType} · {installation.repositorySelection === 'all' ? t('github.allRepositories') : t('github.selectedRepositories')}
                {installation.suspendedAt ? ` · ${t('github.suspended')}` : ''}
              </p>
            </div>
            {installation.manageUrl ? (
              <Button size="icon" variant="ghost" title={t('github.manage')} onClick={() => openExternal(installation.manageUrl!)}>
                <ExternalLink className="h-4 w-4" />
              </Button>
            ) : null}
            <Button
              size="icon"
              variant="ghost"
              title={t('github.disconnect')}
              disabled={busy != null}
              onClick={() => void disconnect(installation.installationId)}
            >
              {busy === installation.installationId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </Button>
          </div>
        ))}
        {state?.configured && state.installations.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">{t('github.empty')}</p>
        ) : null}
      </div>

      <Button disabled={!state?.configured || busy != null} onClick={() => void connect()}>
        {busy === 'connect' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <GitFork className="mr-1.5 h-4 w-4" />}
        {t('github.connect')}
      </Button>
      <p className="text-[11px] text-muted-foreground">{t('github.nativePriority')}</p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
