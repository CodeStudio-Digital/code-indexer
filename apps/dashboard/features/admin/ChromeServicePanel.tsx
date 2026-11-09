/**
 * Admin panel for the Chrome Service singleton (v4.0).
 *
 * - Toggle on/off (`enabled`)
 * - Inputs for image + host_port
 * - Status badge with colour by lifecycle
 * - Buttons: Restart, Test (live healthcheck)
 * - Read-only display of `wsEndpoint` for sandbox containers + copy
 *
 * Mirrors the structure of `McpServersPanel` so the admin page stays
 * visually consistent. State is small enough to keep inline; the
 * fetch logic lives in `chrome-service-api.ts`.
 */
import React, { useState } from 'react';
import { usePolling } from '../../hooks/usePolling.js';
import { useTranslation } from 'react-i18next';
import { Loader2, Play, Square, RotateCcw, Check, AlertCircle, Copy } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { copyText } from '../../lib/clipboard.js';
import {
  fetchChromeService,
  patchChromeService,
  restartChromeService,
  testChromeService,
  type ChromeServiceState,
} from './chrome-service-api.js';

const REFRESH_INTERVAL_MS = 5_000;

export function ChromeServicePanel() {
  const { t } = useTranslation('admin');
  const [state, setState] = useState<ChromeServiceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingImage, setEditingImage] = useState('');
  const [editingPort, setEditingPort] = useState<number>(9222);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const next = await fetchChromeService();
      setState(next);
      setEditingImage(next.image);
      setEditingPort(next.hostPort);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Visibility-aware status poll — pauses while the window is hidden.
  usePolling(refresh, REFRESH_INTERVAL_MS);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(enabled: boolean) {
    await withBusy(async () => {
      const next = await patchChromeService({ enabled });
      setState(next);
    });
  }

  async function applyConfig() {
    await withBusy(async () => {
      const next = await patchChromeService({ image: editingImage, host_port: editingPort });
      setState(next);
    });
  }

  async function restart() {
    await withBusy(async () => {
      const next = await restartChromeService();
      setState(next);
    });
  }

  async function test() {
    await withBusy(async () => {
      const next = await testChromeService();
      setState(next);
    });
  }

  if (loading && !state) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('service.loading', { name: t('chrome.title') })}
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

  const dirty = editingImage !== state.image || editingPort !== state.hostPort;

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">{t('chrome.title')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('chrome.description')}
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

      <EndpointPanel state={state} />
    </div>
  );
}

function StatusBadge({ state }: { state: ChromeServiceState }) {
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
      {state.browser && <span className="text-xs opacity-80">· {state.browser}</span>}
      {state.protocolVersion && <span className="text-xs opacity-80">· CDP {state.protocolVersion}</span>}
      {state.lastError && state.status === 'error' && (
        <span className="text-xs opacity-80 max-w-[400px] truncate" title={state.lastError}>
          · {state.lastError}
        </span>
      )}
    </div>
  );
}

function EndpointPanel({ state }: { state: ChromeServiceState }) {
  const { t } = useTranslation('admin');
  const [copied, setCopied] = useState(false);
  if (state.status !== 'running' || !state.wsEndpoint) {
    return (
      <div className="border rounded p-3 text-sm text-muted-foreground">
        {t('chrome.endpointPending')}
      </div>
    );
  }
  function copy() {
    void copyText(state.wsEndpoint).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    });
  }
  return (
    <div className="border rounded p-3">
      <div className="text-xs font-medium mb-1">{t('chrome.endpointLabel')}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 bg-muted px-2 py-1 rounded text-sm font-mono break-all">
          {state.wsEndpoint}
        </code>
        <Button variant="outline" size="sm" onClick={copy}>
          <Copy className="h-3 w-3 mr-1" /> {copied ? t('service.copied') : t('service.copy')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mt-2">
        {t('chrome.endpointHelp')}
      </p>
    </div>
  );
}
