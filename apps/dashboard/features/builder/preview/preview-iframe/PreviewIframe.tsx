import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Pause } from 'lucide-react';
import type { SandboxSnapshot, SandboxStepLabel } from '../../useSandboxStatus.js';
import {
  isPreviewMessage,
  type PreviewToParentMessage,
} from '@mcp/services/sandbox/builder/protocol.js';
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
  /**
   * Builder studio: when defined, the toolbar renders a "Select" toggle and
   * the iframe is armed/disarmed for element selection. All optional —
   * non-studio callers omit them and behave exactly as before.
   */
  selectMode?: boolean;
  onToggleSelectMode?: () => void;
  /** Receives origin-validated `mcp:*` messages from the preview app. */
  onPreviewMessage?: (msg: PreviewToParentMessage) => void;
  /** Constrain the iframe width (device frames). `null`/undefined = fill. */
  frameWidth?: number | null;
  /** Extra controls rendered at the right of the preview toolbar. */
  toolbarRightSlot?: React.ReactNode;
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
  selectMode,
  onToggleSelectMode,
  onPreviewMessage,
  frameWidth,
  toolbarRightSlot,
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

  // Phase C: the sandbox manager now emits a direct loopback URL
  // (http://127.0.0.1:<hostPort>/) for both primary and secondary
  // services — the `/preview/:id` proxy was removed. The old
  // per-stack strategy switch collapses to "render whatever the API
  // returned", with no path-rewriting fallback.
  const effectivePreviewUrl = activeExtra
    ? activeExtra.previewUrl
    : sandbox?.previewUrl ?? '';
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

  // ── Builder studio: element-selection wiring ──────────────────────
  // Origin of the loopback dev server — used both to validate inbound
  // messages and as the targetOrigin for arm/disarm posts. Empty until
  // the preview URL is known (selection stays disabled then).
  const previewOrigin = useMemo(() => {
    try {
      return previewUrl ? new URL(previewUrl).origin : '';
    } catch {
      return '';
    }
  }, [previewUrl]);

  const selectModeRef = useRef(!!selectMode);
  selectModeRef.current = !!selectMode;

  const postToPreview = React.useCallback(
    (msg: { type: 'mcp:arm' | 'mcp:disarm' }) => {
      if (!previewOrigin) return;
      iframeRef.current?.contentWindow?.postMessage(msg, previewOrigin);
    },
    [previewOrigin],
  );

  // Inbound messages from the preview app. STRICT origin check — never
  // trust `event.origin` blindly (a malicious page could spoof selections).
  useEffect(() => {
    if (!onPreviewMessage || !previewOrigin) return;
    function onMessage(e: MessageEvent) {
      if (e.origin !== previewOrigin) return;
      if (!isPreviewMessage(e.data)) return;
      // Re-arm after a reload (the runtime re-announces readiness).
      if (e.data.type === 'mcp:ready' && selectModeRef.current) postToPreview({ type: 'mcp:arm' });
      onPreviewMessage(e.data);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onPreviewMessage, previewOrigin, postToPreview]);

  // Arm/disarm whenever select mode toggles (and on (re)mount of the iframe
  // via reloadKey, once it's ready).
  useEffect(() => {
    if (selectMode === undefined) return;
    postToPreview({ type: selectMode ? 'mcp:arm' : 'mcp:disarm' });
  }, [selectMode, reloadKey, postToPreview]);

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
        selectMode={selectMode}
        onToggleSelectMode={onToggleSelectMode}
        rightSlot={toolbarRightSlot}
      />
      <div className="flex-1 relative overflow-hidden flex flex-col">
        {effectiveStatus === 'ready' && previewUrl && !runtimePaused ? (
          <div
            className="w-full h-full flex justify-center overflow-auto bg-muted/30"
            style={frameWidth ? undefined : { display: 'block' }}
          >
            <iframe
              key={reloadKey}
              ref={iframeRef}
              src={previewUrl}
              className="h-full border-0 bg-white"
              style={{ width: frameWidth ? `${frameWidth}px` : '100%', maxWidth: '100%' }}
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
              title="Sandbox preview"
            />
          </div>
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
