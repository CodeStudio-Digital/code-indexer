import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Pause } from 'lucide-react';
import type { SandboxSnapshot, SandboxStepLabel } from '../../useSandboxStatus.js';
import { LogTail } from './LogTail.js';
import { PreviewToolbar } from './PreviewToolbar.js';
import { DevServerLogOverlay } from './DevServerLogOverlay.js';

export interface PreviewIframeProps {
  snapshot: SandboxSnapshot | null;
  onRefresh: () => void;
  onRetry: () => Promise<void>;
  onRestartDev: () => Promise<void>;
  sessionId: number;
  fileChangeTick?: number;
  extraServices?: Array<{
    id: string;
    label: string;
    previewUrl: string;
    status: string;
    runtimePaused?: boolean;
    previewStrategy?: 'proxy-prefix' | 'proxy-root' | 'port-direct';
    hostPort?: number;
  }>;
}

const STEP_LABELS: Record<SandboxStepLabel, string> = {
  queued: 'Queued',
  'creating-container': 'Creating container…',
  scaffolding: 'Scaffolding project…',
  'installing-deps': 'Installing dependencies (npm install)…',
  'starting-dev-server': 'Starting dev server…',
  ready: 'Ready',
  error: 'Error',
};

export function PreviewIframe({
  snapshot,
  onRefresh,
  onRetry,
  onRestartDev,
  sessionId,
  fileChangeTick = 0,
  extraServices = [],
}: PreviewIframeProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [restartingDev, setRestartingDev] = useState(false);
  const [logOverlayOpen, setLogOverlayOpen] = useState(false);
  const [selectedService, setSelectedService] = useState<string>('main');

  const sandbox = snapshot?.sandbox;
  const status = sandbox?.status ?? (snapshot?.builder ? 'paused' : null);
  const activeExtra =
    selectedService !== 'main'
      ? extraServices.find((s) => s.id === selectedService) ?? null
      : null;

  // Phase 4: when the chosen service uses `port-direct`, the iframe bypasses
  // the `/preview/${id}` proxy and loads `http://localhost:${hostPort}`
  // directly. This is the path for projects whose dev server doesn't
  // tolerate a path prefix (Next dev, raw Vite with `--base /`, etc.).
  // The proxied URL stays as the fallback for everything else.
  function resolveIframeSrc(): string {
    if (activeExtra) {
      if (
        activeExtra.previewStrategy === 'port-direct' &&
        typeof activeExtra.hostPort === 'number' &&
        activeExtra.hostPort > 0
      ) {
        return `http://localhost:${activeExtra.hostPort}/`;
      }
      return activeExtra.previewUrl;
    }
    // The primary's strategy is encoded by the dashboard's primary
    // service entry in `extraServices` when present. When absent (the
    // typical case in builder mode), fall back to the legacy proxy URL
    // built by the sandbox manager.
    return sandbox?.previewUrl ?? '';
  }
  const effectivePreviewUrl = resolveIframeSrc();
  const effectiveStatus = activeExtra
    ? activeExtra.status === 'ready' || activeExtra.status === 'running'
      ? 'ready'
      : activeExtra.status
    : status;
  const runtimePaused = activeExtra ? !!activeExtra.runtimePaused : !!sandbox?.runtimePaused;
  const toolbarStatus = runtimePaused ? 'paused' : effectiveStatus;

  useEffect(() => {
    if (fileChangeTick > 0 && status === 'ready') {
      setReloadKey((k) => k + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileChangeTick]);

  const step = sandbox?.step;
  const logs = sandbox?.recentLogs ?? [];
  const previewUrl = effectivePreviewUrl;

  async function handleRetry() {
    setRetrying(true);
    try { await onRetry(); } finally { setRetrying(false); }
  }
  async function handleRestartDev() {
    setRestartingDev(true);
    try {
      await onRestartDev();
      setReloadKey((k) => k + 1);
    } finally {
      setRestartingDev(false);
    }
  }

  const serviceSwitcher = extraServices.length > 0 ? (
    <select
      className="text-xs bg-background border rounded px-1 py-0.5 max-w-[180px]"
      value={selectedService}
      onChange={(e) => {
        setSelectedService(e.target.value);
        setReloadKey((k) => k + 1);
      }}
      title="Switch preview target"
    >
      <option value="main">Primary</option>
      {extraServices.map((s) => (
        <option key={s.id} value={s.id}>{s.label} ({s.runtimePaused ? 'paused' : s.status})</option>
      ))}
    </select>
  ) : null;

  return (
    <div className="flex flex-col h-full bg-card">
      <PreviewToolbar
        status={toolbarStatus}
        previewUrl={previewUrl}
        restartingDev={restartingDev}
        canOpenLogs={!!sandbox && !runtimePaused}
        onRestartDev={handleRestartDev}
        onOpenLogs={() => setLogOverlayOpen(true)}
        onReload={() => { setReloadKey((k) => k + 1); onRefresh(); }}
        serviceSwitcher={serviceSwitcher}
      />
      <div className="flex-1 relative overflow-hidden flex flex-col">
        {effectiveStatus === 'ready' && previewUrl && !runtimePaused ? (
          <iframe
            key={reloadKey}
            ref={iframeRef}
            src={previewUrl}
            className="w-full h-full border-0"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
            title="Sandbox preview"
          />
        ) : effectiveStatus === 'error' ? (
          <div className="flex-1 flex flex-col p-4 gap-3 overflow-hidden">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold">Sandbox failed to start</div>
                <pre className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap break-words">
                  {sandbox?.error ?? 'Unknown error'}
                </pre>
              </div>
              <button
                onClick={handleRetry}
                disabled={retrying}
                className="px-3 py-1.5 rounded-md border text-xs hover:bg-muted disabled:opacity-40"
              >
                {retrying ? 'Retrying…' : 'Retry'}
              </button>
            </div>
            <LogTail lines={logs} />
          </div>
        ) : runtimePaused ? (
          <div className="flex-1 flex flex-col p-4 gap-3 overflow-hidden">
            <div className="flex items-center gap-3">
              <Pause className="h-5 w-5 text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">Container paused</div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  The process tree is frozen; files, ports, and dependencies are preserved.
                </p>
              </div>
            </div>
            <LogTail lines={logs} />
          </div>
        ) : effectiveStatus === 'paused' ? (
          <div className="flex-1 flex flex-col p-4 gap-3 overflow-hidden">
            <div className="flex items-center gap-3">
              <Pause className="h-5 w-5 text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">Container paused</div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Press Play in the Microservices list to start it. Files and dependencies stay on disk.
                </p>
              </div>
            </div>
            <LogTail lines={logs} />
          </div>
        ) : (
          <div className="flex-1 flex flex-col p-4 gap-3 overflow-hidden">
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">
                  {step ? STEP_LABELS[step] : 'Waiting for sandbox…'}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {snapshot?.builder?.stack ?? 'Vite'} project is being created inside an isolated
                  container. First boot can take up to a minute; subsequent sessions are much faster.
                </p>
              </div>
            </div>
            <LogTail lines={logs} />
          </div>
        )}
        {logOverlayOpen && (
          <DevServerLogOverlay
            sessionId={sessionId}
            serviceId={selectedService !== 'main' ? selectedService : null}
            onClose={() => setLogOverlayOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
