import {
  UNIVERSAL_INSPECTOR_SOURCE, REACT_DETECT_SOURCE, UNIVERSAL_TOOLBAR_SOURCE, REGION_HELPERS_SOURCE,
} from '@mcp/services/preview/inspector-assets.js';
import type { PreviewInvoke } from '@mcp/code-agent/tools/preview/contracts.js';
import type { PreviewWindow } from './cdp.js';
import { VIEWPORT_PRESETS, applyViewport } from './viewport.js';

/** Dashboard inspection is separate from agent operation ownership. */
export abstract class PreviewInspector {
  /** Per-key selection subscribers (dashboard "Inspect"). Decoupled from the
   *  window lifecycle so a stream can subscribe before the window opens. */
  protected inspectListeners = new Map<string, Set<(d: unknown) => void>>();
  /** Windows whose CDP selection events are already forwarded to the map. */
  protected inspectForwarded = new WeakSet<PreviewWindow>();
  protected abstract getPreview(key: string): PreviewWindow | undefined;
  abstract invoke(request: PreviewInvoke): Promise<unknown>;
  abstract closeKey(key: string): void;

  // ── Dashboard-driven "Inspect" (universal element selection) ──────────
  // Reuses the agent CDP window machinery: open the app, inject the
  // framework-agnostic inspector, and stream selections back to the dashboard.

  /** Subscribe to selections for a key. Safe to call before `openInspect`. */
  onInspectSelect(key: string, cb: (d: unknown) => void): () => void {
    let set = this.inspectListeners.get(key);
    if (!set) this.inspectListeners.set(key, (set = new Set()));
    set.add(cb);
    return () => { this.inspectListeners.get(key)?.delete(cb); };
  }

  protected fanoutSelect(key: string, d: unknown): void {
    const set = this.inspectListeners.get(key);
    if (set) for (const cb of Array.from(set)) { try { cb(d); } catch { /* listener threw */ } }
  }

  /**
   * Open (or reuse) the window at `url` and inject the inspector + control bar.
   * `arm` starts in selection mode; otherwise it opens in navigate mode (the
   * bar's Inspect toggle / dashboard can arm later). Used by both the dashboard
   * "Inspect" (arm) and "Open in new window" (navigate) entry points.
   */
  async openInspect(
    key: string,
    url: string,
    opts: { arm?: boolean; selectorMode?: string } = {},
  ): Promise<{ windowId: number; url: string }> {
    const res = await this.invoke({ key, method: 'open', args: { url } }) as { windowId: number; url: string };
    const pw = this.getPreview(key);
    if (pw) {
      if (!this.inspectForwarded.has(pw)) {
        pw.onSelect((d) => this.fanoutSelect(key, d));
        pw.onControl((action) => this.handleControl(key, action));
        this.inspectForwarded.add(pw);
      }
      // detection globals + region helpers FIRST (the inspector's detect()/marquee
      // handlers call them), then the inspector, then the floating control bar.
      await pw.armInspect(`${REACT_DETECT_SOURCE}\n${REGION_HELPERS_SOURCE}\n${UNIVERSAL_INSPECTOR_SOURCE}\n${UNIVERSAL_TOOLBAR_SOURCE}`);
      // Selector mode: 'react' forces a React label on fiberless nodes (RSC),
      // 'universal' keeps react→vue→angular→css. setSelectorMode registers it as
      // its own on-new-document script so it survives in-window navigation/reload
      // (not just the first page), and updates the current doc immediately.
      const mode =
        opts.selectorMode === 'react' || opts.selectorMode === 'universal' ? opts.selectorMode : 'auto';
      await pw.setSelectorMode(mode);
      await pw.send('Runtime.evaluate', {
        expression: opts.arm ? 'window.__mcpArm && window.__mcpArm()' : 'window.__mcpDisarm && window.__mcpDisarm()',
      }).catch(() => undefined);
    }
    return { windowId: res.windowId, url: res.url };
  }

  /** Live-update an open inspect window's selector mode (dashboard toggle while
   *  the window stays open). No-op if the window isn't open. */
  async setInspectMode(key: string, mode: string): Promise<void> {
    const pw = this.getPreview(key);
    if (pw && !pw.win.isDestroyed()) {
      const m = mode === 'react' || mode === 'universal' ? mode : 'auto';
      await pw.setSelectorMode(m);
    }
  }

  async disarmInspect(key: string): Promise<void> {
    const pw = this.getPreview(key);
    if (pw && !pw.win.isDestroyed()) await pw.disarmInspect();
  }

  /** Bring the inspect window to the front (dashboard "Focus"). */
  focusInspect(key: string): void {
    const pw = this.getPreview(key);
    if (pw && !pw.win.isDestroyed()) { try { pw.win.focus(); } catch { /* gone */ } }
  }

  /** Control-bar actions from the injected toolbar (`viewport:<preset>`, `close`). */
  private handleControl(key: string, action: string): void {
    if (action === 'close') { this.closeKey(key); return; }
    if (action.startsWith('viewport:')) {
      const vp = VIEWPORT_PRESETS[action.slice('viewport:'.length)];
      const pw = this.getPreview(key);
      if (pw && vp) applyViewport(pw, vp);
    }
  }

}
