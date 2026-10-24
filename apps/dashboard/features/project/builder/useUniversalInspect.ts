/**
 * Drives the CDP preview window for a running project: opens the app in
 * CodeStudio's dedicated window (main process), injects the framework-agnostic
 * picker + floating control bar, and streams selections into the SHARED
 * selection store — so the existing `SelectionChip` + `consumeSelectionPrefix`
 * composer path lights up for ANY stack with no changes to the project.
 *
 * One windowed-preview concept with two entry points: `open(true)` = Inspect
 * (selection mode), `open(false)` = "open in new window" (navigate mode; the
 * in-window bar toggles selection on). Electron-only (the CDP window lives in
 * the main process); `canInspect` is false in browser dev or until a dev URL
 * resolves. Separate from the inline `data-mcp-loc` builder path.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiCall, apiStream, electronApi } from '../../../lib/api-client.js';
import {
  addPendingAttachment,
  addSelections,
  payloadToSelected,
  setSelected,
  toggleSelected,
  type SelectedElement,
} from '../../builder/studio/studio-context-store.js';

/** A marquee pick streamed from the CDP inspector (`window.__mcpRegionSelect`). */
interface RegionFrame {
  type: 'mcp:region-select';
  selections: Array<Omit<SelectedElement, 'type'>>;
  rect: { x: number; y: number; width: number; height: number };
  dpr: number;
}

interface UniversalInspect {
  /** Electron + a resolved dev URL → the window/inspect affordances are usable. */
  canInspect: boolean;
  /** The CDP preview window is currently open (selection or navigate mode). */
  windowOpen: boolean;
  /** Open the window. `arm` → start in selection mode; else navigate mode. */
  open: (arm: boolean) => Promise<void>;
  close: () => void;
  focus: () => void;
}

export function useUniversalInspect(
  projectId: number,
  url: string | null,
  selectorMode: 'react' | 'universal' = 'universal',
): UniversalInspect {
  const [windowOpen, setWindowOpen] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const canInspect = !!url && electronApi() != null;

  const open = useCallback(async (arm: boolean) => {
    if (!url) return;
    let cancelled = false;
    stopRef.current = () => { cancelled = true; };
    // Subscribe BEFORE opening so no early selection / close is missed.
    void (async () => {
      try {
        for await (const d of apiStream<SelectedElement | RegionFrame | { type: 'mcp:closed' }>('previewInspect.events', { projectId })) {
          if (cancelled) break;
          const t = (d as { type?: string })?.type;
          if (t === 'mcp:closed') { setWindowOpen(false); break; }
          if (t === 'mcp:region-select') {
            const rs = d as RegionFrame;
            if (rs.selections?.length) {
              addSelections(projectId, rs.selections.map(payloadToSelected));
            }
            // The CDP window has its own debugger, so clip Page.captureScreenshot
            // directly to the box (window viewport coords — no offset needed).
            void apiCall<{ base64?: string }>('previewInspect.captureRegion', { projectId, clip: rs.rect })
              .then((res) => {
                if (res?.base64) {
                  addPendingAttachment(projectId, { name: `region-${Date.now()}.png`, mediaType: 'image/png', base64: res.base64 });
                }
              })
              .catch(() => { /* capture failed — refs still cite */ });
            continue;
          }
          const sel = d as SelectedElement;
          if (sel.additive) toggleSelected(projectId, sel);
          else setSelected(projectId, sel);
        }
      } catch { /* stream ended / unavailable */ }
    })();
    setWindowOpen(true);
    try {
      await apiCall('previewInspect.open', { projectId, url, arm, selectorMode });
    } catch {
      stopRef.current?.();
      stopRef.current = null;
      setWindowOpen(false);
    }
  }, [projectId, url, selectorMode]);

  // Live mode toggle: the window only ever opens from a CLOSED state (open()
  // sets the initial mode), so this effect only matters when the user cycles
  // SelectorModeButton while the window stays open — push the new mode without
  // re-opening (which would disarm). No-ops on the backend if the window isn't
  // open yet, and is idempotent with open()'s own mode set.
  useEffect(() => {
    if (!windowOpen) return;
    void apiCall('previewInspect.setMode', { projectId, selectorMode }).catch(() => undefined);
  }, [selectorMode, windowOpen, projectId]);

  const close = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setWindowOpen(false);
    void apiCall('previewInspect.close', { projectId }).catch(() => undefined);
  }, [projectId]);

  const focus = useCallback(() => {
    void apiCall('previewInspect.focus', { projectId }).catch(() => undefined);
  }, [projectId]);

  // Always close the window when the pane unmounts (tab switch / nav).
  useEffect(() => {
    return () => {
      stopRef.current?.();
      if (electronApi() != null) void apiCall('previewInspect.close', { projectId }).catch(() => undefined);
    };
  }, [projectId]);

  return { canInspect, windowOpen, open, close, focus };
}
