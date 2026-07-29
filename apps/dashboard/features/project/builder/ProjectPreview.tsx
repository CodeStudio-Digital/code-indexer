import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, BoxSelect, Crosshair, ExternalLink, MousePointerClick, PanelRightClose, Play, RotateCw, Wrench } from 'lucide-react';
import {
  isPreviewMessage,
  type ParentToPreviewMessage,
  type PreviewToParentMessage,
} from '@mcp/services/sandbox/builder/protocol.js';
import { addPendingAttachment, addSelections, payloadToSelected, setSelected, toggleSelected } from '../../builder/studio/studio-context-store.js';
import { SelectionChip } from '../../builder/studio/selection/SelectionChip.js';
import { RegionShotChip } from '../../builder/studio/selection/RegionShotChip.js';
import { apiCall } from '../../../lib/api-client.js';
import { usePreviewProblems } from '../../builder/studio/problems/usePreviewProblems.js';
import { useAutoFix } from '../../builder/studio/problems/useAutoFix.js';
import { ProblemsBadge } from '../../builder/studio/problems/ProblemsBadge.js';
import {
  DeviceFrameSwitcher,
  DEVICE_WIDTH,
  type DeviceFrame,
} from '../../builder/studio/DeviceFrameSwitcher.js';
import { VisualEditPanel } from '../../builder/studio/visual-edit/VisualEditPanel.js';
import { CheckpointsTimeline } from '../../builder/checkpoints/CheckpointsTimeline.js';
import { useProjectDevServer } from './useProjectDevServer.js';
import { PreviewUrlEditor } from './PreviewUrlEditor.js';
import { useUniversalInspect } from './useUniversalInspect.js';
import { useSelectorMode, type PreviewFramework } from './useSelectorMode.js';
import { SelectorModeButton } from './SelectorModeButton.js';
import { apiPost } from '../../../hooks/useApi.js';

/**
 * Open the preview URL in a new window and return the window handle (so the
 * caller can watch `.closed` and restore the in-project iframe when it's
 * dismissed). In Electron, the features string makes the main window-open
 * handler open it INSIDE our shell (loopback URLs allowed — see
 * apps/electron/main.ts). In a plain browser it's a normal new tab.
 */
function openPreviewWindow(url: string): Window | null {
  const isElectron = typeof window !== 'undefined' && !!(window as { electronAPI?: unknown }).electronAPI;
  return window.open(url, '_blank', isElectron ? 'newWindow=yes' : undefined);
}

/**
 * Live-preview pane for a Builder project, rendered beside the chat in the
 * project view. Iframes the host dev server (port pinned at scaffold) and
 * provides element selection (→ chat composer), a unified problems feed +
 * auto-fix, device frames, and dev-server (microservice) controls. The
 * postMessage bridge mirrors the sandbox PreviewIframe but is self-contained
 * so it stays decoupled from the container path.
 */
export function ProjectPreview({
  projectId,
  pinnedPort,
  selectionEnabled = false,
  framework,
  onHide,
}: {
  projectId: number;
  /** Builder projects pin the dev port in vite.config; others auto-detect. */
  pinnedPort?: number;
  /** Element selection (builder projects with the source-stamp only). */
  selectionEnabled?: boolean;
  /** Inferred framework (Project.framework) → auto-picks the selector mode. */
  framework?: PreviewFramework;
  onHide?: () => void;
}) {
  const { status, url, start, restart, manualUrl, setManualUrl } = useProjectDevServer(projectId, {
    pinnedPort,
  });
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const popupRef = useRef<Window | null>(null);
  const [poppedOut, setPoppedOut] = useState(false);
  // The agent opened its OWN dedicated CDP preview window (preview_open tool) →
  // we pause the in-project iframe and show a placeholder, mirroring pop-out.
  // Driven by the `coder:agent_preview` event from the coder stream handlers.
  const [agentPreview, setAgentPreview] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [regionMode, setRegionMode] = useState(false);
  const [device, setDevice] = useState<DeviceFrame>('desktop');
  const [reloadKey, setReloadKey] = useState(0);
  const { problems, add, clear, dismiss, errorCount } = usePreviewProblems();
  // Run-end revalidation: reload the iframe so only errors that still exist
  // re-emit (and fire); fixed ones stay silent. The badge list is kept.
  const onAutoFixRevalidate = useCallback(() => setReloadKey((k) => k + 1), []);
  const {
    autoFixEnabled,
    setAutoFixEnabled,
    autoFixMode,
    setAutoFixMode,
    pendingFix,
    acceptPendingFix,
    dismissPendingFix,
  } = useAutoFix(projectId, problems, {
    onRevalidate: onAutoFixRevalidate,
  });
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);

  const origin = useMemo(() => {
    try {
      return url ? new URL(url).origin : '';
    } catch {
      return '';
    }
  }, [url]);
  const selectModeRef = useRef(selectMode);
  selectModeRef.current = selectMode;
  const regionModeRef = useRef(regionMode);
  regionModeRef.current = regionMode;

  const post = useCallback(
    (msg: ParentToPreviewMessage) => {
      if (origin) iframeRef.current?.contentWindow?.postMessage(msg, origin);
    },
    [origin],
  );

  // Region/marquee pick: cite every element inside the box AND attach a
  // screenshot clipped to it. The inspector reports the box in the iframe's
  // viewport coords; we offset by the iframe's on-screen position and ask the
  // host to capture that rect of the dashboard window (the cross-origin iframe
  // is composited in, so capturePage sees its pixels).
  const handleRegionSelect = useCallback(
    async (msg: Extract<PreviewToParentMessage, { type: 'mcp:region-select' }>) => {
      if (msg.selections.length) {
        addSelections(projectId, msg.selections.map(payloadToSelected));
      }
      const f = iframeRef.current?.getBoundingClientRect();
      if (!f || msg.rect.width < 1 || msg.rect.height < 1) return;
      const rect = {
        x: f.left + msg.rect.x,
        y: f.top + msg.rect.y,
        width: msg.rect.width,
        height: msg.rect.height,
      };
      try {
        const res = await apiCall<{ base64?: string }>('preview.captureRegion', rect);
        if (res?.base64) {
          addPendingAttachment(projectId, {
            name: `region-${Date.now()}.png`,
            mediaType: 'image/png',
            base64: res.base64,
          });
        }
      } catch {
        /* capture unavailable (browser dev / no Electron) — refs still cite */
      }
    },
    [projectId],
  );

  // Re-instrument this Builder project for element selection (rewrites the
  // source-stamp + vite.config, installs @babel/core) then restarts the dev
  // server so Vite reloads. Fixes projects scaffolded before the stamp moved
  // out of plugin-react's (now ignored) `babel` option.
  const repairSelection = useCallback(async () => {
    setRepairing(true);
    setRepairError(null);
    try {
      await apiPost(`/projects/${projectId}/builder/reinstrument`, {});
      await restart();
      setReloadKey((k) => k + 1);
    } catch (e) {
      setRepairError(e instanceof Error ? e.message : 'Repair failed');
    } finally {
      setRepairing(false);
    }
  }, [projectId, restart]);

  // Element-selector mode (universal CDP path). 'auto' resolves to React-native
  // detection for React/Next projects, else the generic universal picker.
  const { mode: selectorMode, setMode: setSelectorMode, effective: effectiveSelector } =
    useSelectorMode(projectId, framework);

  // Universal CDP preview window: Inspect (armed) + "open in new window" (navigate).
  // Both share one window; the in-window floating bar toggles selection.
  const { canInspect, windowOpen, open: openInspectWin, close: closeInspectWin, focus: focusInspectWin } =
    useUniversalInspect(projectId, url, effectiveSelector);

  // Auto-start the dev server when the pane opens for a builder project
  // (pinned port → we know it'll serve). For general projects we wait for
  // the user to run their dev task rather than guessing the command.
  useEffect(() => {
    if (pinnedPort && status === 'stopped') void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Inbound mcp:* messages — STRICT origin check.
  useEffect(() => {
    if (!origin) return;
    function onMessage(e: MessageEvent) {
      if (e.origin !== origin || !isPreviewMessage(e.data)) return;
      const msg = e.data as PreviewToParentMessage;
      if (msg.type === 'mcp:ready') {
        if (regionModeRef.current) post({ type: 'mcp:arm-region' });
        else if (selectModeRef.current) post({ type: 'mcp:arm' });
      }
      else if (msg.type === 'mcp:select') {
        if (msg.additive) toggleSelected(projectId, msg);
        else setSelected(projectId, msg);
      }
      else if (msg.type === 'mcp:region-select') void handleRegionSelect(msg);
      else if (msg.type === 'mcp:clear') setSelected(projectId, null);
      else if (msg.type === 'mcp:runtime-error' || msg.type === 'mcp:network' || msg.type === 'mcp:console') add(msg);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin, projectId, add, post, handleRegionSelect]);

  useEffect(() => {
    if (!selectionEnabled) {
      if (selectMode) setSelectMode(false);
      if (regionMode) setRegionMode(false);
      post({ type: 'mcp:disarm' });
      return;
    }
    if (regionMode) post({ type: 'mcp:arm-region' });
    else if (selectMode) post({ type: 'mcp:arm' });
    else post({ type: 'mcp:disarm' });
  }, [selectionEnabled, selectMode, regionMode, reloadKey, post]);

  // Pop the preview out to a separate window. While popped out the in-project
  // iframe is UNMOUNTED (frees its renderer process) — only one preview
  // renders at a time. We poll the window handle and restore the inline
  // iframe once the user closes it.
  const popOut = useCallback(() => {
    if (!url) return;
    // Electron → unified CDP window (navigate mode) WITH the floating control
    // bar, so the user can toggle Inspect / change device / reload in-window.
    if (canInspect) {
      if (windowOpen) focusInspectWin();
      else void openInspectWin(false);
      return;
    }
    // Browser-dev fallback: plain window.open (no CDP, no bar).
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.focus();
      return;
    }
    const w = openPreviewWindow(url);
    if (w) {
      popupRef.current = w;
      setPoppedOut(true);
    }
  }, [url, canInspect, windowOpen, openInspectWin, focusInspectWin]);

  useEffect(() => {
    if (!poppedOut) return;
    const id = setInterval(() => {
      if (!popupRef.current || popupRef.current.closed) {
        popupRef.current = null;
        setPoppedOut(false);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [poppedOut]);

  // Closing the pane (tab switch / unmount) also closes the pop-out so we
  // never orphan a preview window.
  useEffect(() => {
    return () => {
      if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
    };
  }, []);

  // Agent-driven preview: the coder stream dispatches `coder:agent_preview`
  // when the agent runs preview_open / preview_close (or the run ends). While
  // the agent owns a window, pause this iframe to free the renderer process.
  useEffect(() => {
    function onAgentPreview(e: Event) {
      const d = (e as CustomEvent).detail as { open?: boolean } | undefined;
      setAgentPreview(!!d?.open);
    }
    window.addEventListener('coder:agent_preview', onAgentPreview as EventListener);
    return () => window.removeEventListener('coder:agent_preview', onAgentPreview as EventListener);
  }, []);

  const frameWidth = DEVICE_WIDTH[device];

  return (
    <div className="flex flex-col h-full min-h-0 bg-card">
      <div className="h-10 flex items-center gap-2 px-3 border-b shrink-0">
        <span
          className={`h-2 w-2 rounded-full ${status === 'running' ? 'bg-green-500' : 'bg-muted-foreground'}`}
          title={status}
        />
        {/* URL clicável → editor inline. O override manual é sticky por
            projeto (localStorage) e vence a detecção; o chip âmbar mostra
            isso e limpa com um clique. */}
        <PreviewUrlEditor url={url} manualUrl={manualUrl} onSet={setManualUrl} />
        <DeviceFrameSwitcher value={device} onChange={setDevice} />
        {/* Universal inspect is the fallback for stacks without the inline
            data-mcp-loc selector — hide it when that precise selector is
            available (builder/Vite) so we don't show two pickers. */}
        {canInspect && !selectionEnabled && (
          <>
            <SelectorModeButton
              mode={selectorMode}
              effective={effectiveSelector}
              framework={framework}
              onChange={setSelectorMode}
            />
            <button
              onClick={() => { if (windowOpen) closeInspectWin(); else void openInspectWin(true); }}
              className={`p-1.5 rounded-md ${windowOpen ? 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40' : 'hover:bg-muted'}`}
              title={windowOpen
                ? 'Close the preview window'
                : effectiveSelector === 'react'
                  ? 'Inspect (React-native detection) — open the app in a window with a control bar; pick any element to cite its component'
                  : 'Inspect — open the app in a window with a control bar; pick any element (any framework) to cite it'}
            >
              <Crosshair className={`h-3.5 w-3.5 ${effectiveSelector === 'react' && !windowOpen ? 'text-indigo-600 dark:text-indigo-400' : ''}`} />
            </button>
          </>
        )}
        {selectionEnabled && (
          <>
            <button
              onClick={() => { setSelectMode((v) => !v); setRegionMode(false); }}
              className={`p-1.5 rounded-md ${selectMode ? 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40' : 'hover:bg-muted'}`}
              title={selectMode ? 'Selecting — click an element (Esc to cancel)' : 'Select an element to edit'}
            >
              <MousePointerClick className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => { setRegionMode((v) => !v); setSelectMode(false); }}
              className={`p-1.5 rounded-md ${regionMode ? 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40' : 'hover:bg-muted'}`}
              title={regionMode ? 'Region — drag a box to cite everything inside it + a screenshot (Esc to cancel)' : 'Select a region: drag a box to cite every element inside it and attach a screenshot'}
            >
              <BoxSelect className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={repairSelection}
              disabled={repairing}
              className="p-1.5 rounded-md hover:bg-muted disabled:opacity-40"
              title={
                repairError
                  ? `Repair failed: ${repairError}`
                  : 'Update preview tooling — re-instrument + restart the dev server. Use if element picking or visual editing does nothing (older projects need this once).'
              }
            >
              <Wrench className={`h-3.5 w-3.5 ${repairing ? 'animate-pulse' : ''} ${repairError ? 'text-destructive' : ''}`} />
            </button>
          </>
        )}
        <ProblemsBadge
          projectId={projectId}
          problems={problems}
          errorCount={errorCount}
          onDismiss={dismiss}
          onClear={clear}
          autoFixEnabled={autoFixEnabled}
          onToggleAutoFix={() => setAutoFixEnabled(!autoFixEnabled)}
          autoFixMode={autoFixMode}
          onSetAutoFixMode={setAutoFixMode}
        />
        <button
          onClick={() => { void restart(); setReloadKey((k) => k + 1); }}
          className="p-1.5 rounded-md hover:bg-muted"
          title="Restart dev server"
        >
          {status === 'running' ? <RotateCw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={popOut}
          disabled={!url}
          className={`p-1.5 rounded-md hover:bg-muted disabled:opacity-40 ${poppedOut || windowOpen ? 'text-indigo-600' : ''}`}
          title={poppedOut || windowOpen ? 'Preview is in a separate window — click to focus' : 'Open preview in a new window'}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
        {onHide && (
          <button onClick={onHide} className="p-1.5 rounded-md hover:bg-muted" title="Hide preview">
            <PanelRightClose className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0 flex justify-center overflow-auto bg-muted/30">
        {poppedOut ? (
          <div className="m-auto flex flex-col items-center gap-3 text-center text-sm text-muted-foreground p-6">
            <ExternalLink className="h-8 w-8 text-indigo-400" />
            <p>Preview is open in a separate window.</p>
            <div className="flex gap-2">
              <button
                onClick={() => popupRef.current?.focus()}
                className="px-3 py-1.5 rounded-md border hover:bg-muted text-foreground"
              >
                Focus window
              </button>
              <button
                onClick={() => popupRef.current?.close()}
                className="px-3 py-1.5 rounded-md border hover:bg-muted text-foreground"
              >
                Bring back here
              </button>
            </div>
          </div>
        ) : agentPreview ? (
          <div className="m-auto flex flex-col items-center gap-3 text-center text-sm text-muted-foreground p-6">
            <Bot className="h-8 w-8 text-indigo-400" />
            <p>O agente está usando o preview numa janela dedicada (modo preview).</p>
            <p className="text-xs">O iframe aqui foi pausado para liberar processo — volta sozinho quando o agente fechar o preview ou o run terminar.</p>
          </div>
        ) : windowOpen ? (
          <div className="m-auto flex flex-col items-center gap-3 text-center text-sm text-muted-foreground p-6">
            <Crosshair className="h-8 w-8 text-indigo-400" />
            <p>Preview aberto numa janela dedicada (com barra de controle).</p>
            <p className="text-xs">Navegue à vontade e use o botão <b>Inspect</b> da barra para selecionar elementos — eles aparecem abaixo para citar. O preview inline fica pausado enquanto a janela está aberta.</p>
            <div className="flex gap-2">
              <button onClick={focusInspectWin} className="px-3 py-1.5 rounded-md border hover:bg-muted text-foreground">
                Focar janela
              </button>
              <button onClick={closeInspectWin} className="px-3 py-1.5 rounded-md border hover:bg-muted text-foreground">
                Fechar
              </button>
            </div>
          </div>
        ) : url ? (
          <iframe
            key={reloadKey}
            ref={iframeRef}
            src={url}
            className="h-full border-0 bg-white"
            style={{ width: frameWidth ? `${frameWidth}px` : '100%', maxWidth: '100%' }}
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
            title="Project preview"
          />
        ) : (
          <div className="m-auto flex flex-col items-center gap-3 text-center text-sm text-muted-foreground p-6">
            <p>No dev server detected for this project.</p>
            <button onClick={() => void start()} className="px-3 py-1.5 rounded-md border hover:bg-muted text-foreground">
              Start dev server
            </button>
            <div className="flex items-center gap-2">
              <span className="text-xs">or enter URL:</span>
              <input
                defaultValue={manualUrl}
                onBlur={(e) => setManualUrl(e.target.value.trim())}
                onKeyDown={(e) => e.key === 'Enter' && setManualUrl((e.target as HTMLInputElement).value.trim())}
                placeholder="http://localhost:3000"
                className="rounded-md border bg-background px-2 py-1 text-xs font-mono w-48"
              />
            </div>
          </div>
        )}
      </div>
      {pendingFix && (
        <div className="flex items-center gap-2 px-2 py-1 border-t bg-amber-50 dark:bg-amber-950/30 text-xs">
          <Wrench className="h-3.5 w-3.5 text-amber-600 shrink-0" />
          <span className="flex-1 truncate text-muted-foreground" title={pendingFix.problem.label}>
            Fix staged: {pendingFix.problem.label}
          </span>
          <button onClick={acceptPendingFix} className="text-indigo-600 hover:underline shrink-0">
            Send to agent
          </button>
          <button onClick={dismissPendingFix} className="text-muted-foreground hover:text-foreground shrink-0">
            Dismiss
          </button>
        </div>
      )}
      {(selectionEnabled || windowOpen) && (
        <div className="px-2 py-1 border-t empty:hidden">
          <SelectionChip projectId={projectId} />
          <RegionShotChip projectId={projectId} />
        </div>
      )}
      {/* Two-way visual editing — stamped iframe only (loc write-back). */}
      <VisualEditPanel
        projectId={projectId}
        postToPreview={post}
        origin={origin}
        enabled={selectionEnabled && !poppedOut && !agentPreview && !windowOpen && !!url}
      />
      {/* Checkpoint timeline — every agent run lands as a restorable commit. */}
      <CheckpointsTimeline projectId={projectId} />
    </div>
  );
}
