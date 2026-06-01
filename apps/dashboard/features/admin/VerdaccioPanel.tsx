/**
 * Admin panel for the embedded Verdaccio singleton.
 * Mirrors ChromeServicePanel 1:1 — toggle, image/port editing, restart,
 * live status, and the registry URL the company sandboxes will install
 * from.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Play, Square, RotateCcw, Check, AlertCircle, Copy } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { copyText } from '../../lib/clipboard.js';
import {
  fetchVerdaccio,
  patchVerdaccio,
  restartVerdaccio,
  testVerdaccio,
  type VerdaccioState,
} from './verdaccio-api.js';

const REFRESH_INTERVAL_MS = 5_000;

export function VerdaccioPanel() {
  const { t } = useTranslation('admin');
  const [state, setState] = useState<VerdaccioState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingImage, setEditingImage] = useState('');
  const [editingPort, setEditingPort] = useState<number>(4873);
  const [editingMaxPatch, setEditingMaxPatch] = useState<number>(50);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const next = await fetchVerdaccio();
      setState(next);
      setEditingImage(next.image);
      setEditingPort(next.hostPort);
      setEditingMaxPatch(next.maxPatchVersionsPerMinor);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function toggle(enabled: boolean) {
    await withBusy(async () => {
      const next = await patchVerdaccio({ enabled });
      setState(next);
    });
  }

  async function applyConfig() {
    await withBusy(async () => {
      const next = await patchVerdaccio({
        image: editingImage,
        host_port: editingPort,
        max_patch_versions_per_minor: editingMaxPatch,
      });
      setState(next);
    });
  }

  async function restart() {
    await withBusy(async () => {
      const next = await restartVerdaccio();
      setState(next);
    });
  }

  async function test() {
    await withBusy(async () => {
      const next = await testVerdaccio();
      setState(next);
    });
  }

  if (loading && !state) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('service.loading', { name: 'Verdaccio' })}
      </div>
    );
  }
  if (!state) {
    return (
      <div className="p-4 text-sm text-red-600">
        {t('service.failed')} {error ?? t('service.unknown')}
        <button onClick={() => void refresh()} className="ml-2 underline">{t('service.retry')}</button>
      </div>
    );
  }

  const dirty =
    editingImage !== state.image ||
    editingPort !== state.hostPort ||
    editingMaxPatch !== state.maxPatchVersionsPerMinor;

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">{t('verdaccio.title')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('verdaccio.description')}
        </p>
      </header>

      {error && (
        <div className="border border-red-300 bg-red-50 text-red-800 text-sm p-3 rounded flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <pre className="whitespace-pre-wrap text-xs flex-1">{error}</pre>
          <button onClick={() => setError(null)} className="text-xs underline">{t('service.dismiss')}</button>
        </div>
      )}

      <StatusBadge state={state} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 border rounded p-4">
        <div>
          <label className="text-xs font-medium block mb-1">{t('service.image')}</label>
          <input
            type="text"
            value={editingImage}
            onChange={(e) => setEditingImage(e.target.value)}
            disabled={busy}
            className="w-full text-sm border rounded px-2 py-1 font-mono"
          />
        </div>
        <div>
          <label className="text-xs font-medium block mb-1">{t('service.hostPort')}</label>
          <input
            type="number"
            min={1}
            max={65535}
            value={editingPort}
            onChange={(e) => setEditingPort(Number(e.target.value))}
            disabled={busy}
            className="w-full text-sm border rounded px-2 py-1 font-mono"
          />
        </div>
        <div>
          <label className="text-xs font-medium block mb-1">{t('verdaccio.maxPatch')}</label>
          <input
            type="number"
            min={1}
            max={10000}
            value={editingMaxPatch}
            onChange={(e) => setEditingMaxPatch(Number(e.target.value))}
            disabled={busy}
            className="w-full text-sm border rounded px-2 py-1 font-mono"
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            {t('verdaccio.maxPatchHelp')}
          </p>
        </div>
        <div className="md:col-span-2 flex items-center gap-2">
          {state.enabled ? (
            <Button variant="outline" onClick={() => void toggle(false)} disabled={busy} size="sm">
              <Square className="h-3.5 w-3.5 mr-1" /> {t('service.disable')}
            </Button>
          ) : (
            <Button onClick={() => void toggle(true)} disabled={busy} size="sm">
              <Play className="h-3.5 w-3.5 mr-1" /> {t('service.enable')}
            </Button>
          )}
          <Button variant="outline" onClick={() => void restart()} disabled={busy || !state.enabled} size="sm">
            <RotateCcw className="h-3.5 w-3.5 mr-1" /> {t('service.restart')}
          </Button>
          <Button variant="outline" onClick={() => void test()} disabled={busy} size="sm">
            <Check className="h-3.5 w-3.5 mr-1" /> {t('service.test')}
          </Button>
          <Button onClick={() => void applyConfig()} disabled={busy || !dirty} size="sm">
            {t('service.applyConfig')}
          </Button>
        </div>
      </div>

      <RegistryPanel state={state} />
    </div>
  );
}

function StatusBadge({ state }: { state: VerdaccioState }) {
  const tone =
    state.status === 'running'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
      : state.status === 'starting'
        ? 'border-sky-300 bg-sky-50 text-sky-800'
        : state.status === 'error'
          ? 'border-red-300 bg-red-50 text-red-800'
          : 'border-zinc-300 bg-zinc-50 text-zinc-700';
  return (
    <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded border ${tone}`}>
      <span className="text-xs uppercase tracking-wider font-semibold">{state.status}</span>
      {state.lastError && state.status === 'error' && (
        <span className="text-xs opacity-80 max-w-[400px] truncate" title={state.lastError}>
          · {state.lastError}
        </span>
      )}
    </div>
  );
}

function RegistryPanel({ state }: { state: VerdaccioState }) {
  const { t } = useTranslation('admin');
  const [copied, setCopied] = useState(false);
  if (state.status !== 'running' || !state.registryUrl) {
    return (
      <div className="border rounded p-3 text-sm text-muted-foreground">
        {t('verdaccio.registryPending')}
      </div>
    );
  }
  function copy() {
    void copyText(state.registryUrl).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    });
  }
  return (
    <div className="border rounded p-3">
      <div className="text-xs font-medium mb-1">{t('verdaccio.registryLabel')}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 bg-muted px-2 py-1 rounded text-sm font-mono break-all">
          {state.registryUrl}
        </code>
        <Button variant="outline" size="sm" onClick={copy}>
          <Copy className="h-3 w-3 mr-1" /> {copied ? t('service.copied') : t('service.copy')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mt-2">
        {t('verdaccio.registryHelp')}
      </p>
    </div>
  );
}
