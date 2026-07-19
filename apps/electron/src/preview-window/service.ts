/**
 * Main-process implementation of the agent preview/devtools backend. Opens a
 * dedicated, SANDBOXED BrowserWindow per agent key (no preload → the dev page
 * never gets `electronAPI`), attaches CDP, and dispatches the `preview_*`
 * tool calls. Registered via `setGlobalPreviewDevtools` in main.ts.
 */
import { BrowserWindow, session, type Session } from 'electron';
import type { IPreviewDevtools, PreviewInvoke } from '@mcp/code-agent/tools/preview/index.js';
import { UNIVERSAL_INSPECTOR_SOURCE } from '@mcp/services/sandbox/builder/inspector/universal-inspector-source.js';
import { REACT_DETECT_SOURCE } from '@mcp/services/sandbox/builder/inspector/react-detect-source.js';
import { UNIVERSAL_TOOLBAR_SOURCE } from '@mcp/services/sandbox/builder/inspector/universal-toolbar-source.js';
import { REGION_HELPERS_SOURCE } from '@mcp/services/sandbox/builder/inspector/region-runtime.js';
import { PreviewWindow, DEFAULT_VIEWPORT, type Viewport } from './cdp.js';
import { dispatchInteraction } from './interact.js';
import { resolveViewport, applyViewport, clampToScreen, VIEWPORT_PRESETS } from './viewport.js';
import { resolveAppIconPath } from '../app-icon.js';
import { resolveDevUrl, type RunnerBridge } from './dev-server-resolver.js';

const PREVIEW_BODY_DEFAULT_CHARS = 20_000;
const PREVIEW_BODY_MAX_CHARS = 200_000;
const PREVIEW_BODY_TOTAL_DEFAULT_CHARS = 200_000;
const PREVIEW_BODY_TOTAL_MAX_CHARS = 2_000_000;

function abortError(): Error {
  const error = new Error('Preview operation aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function isAllowedPreviewUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username
      && !url.password
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]');
  } catch {
    return false;
  }
}

function requireAllowedPreviewUrl(raw: string): string {
  const url = raw.trim();
  if (!isAllowedPreviewUrl(url)) {
    throw new Error('Preview URL must be an http(s) loopback URL (localhost, 127.0.0.1, or [::1]).');
  }
  return url;
}

function partitionForKey(key: string): string {
  return `mcp-preview-${key.replace(/[^a-z0-9_-]/gi, '_').slice(0, 120)}`;
}

function boundedCount(value: unknown, fallback: number, max = 250): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(parsed, max));
}

export class PreviewWindowService implements IPreviewDevtools {
  private byKey = new Map<string, PreviewWindow>();
  private inFlight = new Map<string, AbortController>();
  private configuredSessions = new WeakSet<Session>();
  /** Per-key selection subscribers (dashboard "Inspect"). Decoupled from the
   *  window lifecycle so a stream can subscribe before the window opens. */
  private inspectListeners = new Map<string, Set<(d: unknown) => void>>();
  /** Windows whose CDP selection events are already forwarded to the map. */
  private inspectForwarded = new WeakSet<PreviewWindow>();
  /** Dev servers THIS service started for a preview (key → runner taskId).
   *  Kept SEPARATE from byKey so closing the window (turn end) doesn't drop
   *  ownership — the owned server is stopped only on closeSession (evict). */
  private ownedTaskByKey = new Map<string, string>();

  /** Injected in main.ts (null in tests / non-runner contexts). Enables
   *  url-less preview_open: reuse the project's running runner or start one. */
  constructor(private runnerBridge: RunnerBridge | null = null) {}

  setRunnerBridge(bridge: RunnerBridge | null): void {
    this.runnerBridge = bridge;
  }

  async invoke(req: PreviewInvoke): Promise<unknown> {
    const requestId = req.requestId;
    const controller = new AbortController();
    if (requestId) this.inFlight.set(requestId, controller);
    try {
      return await this.invokeInternal(req, controller.signal);
    } finally {
      if (requestId && this.inFlight.get(requestId) === controller) this.inFlight.delete(requestId);
    }
  }

  cancel(requestId: string): void {
    this.inFlight.get(requestId)?.abort();
  }

  private async invokeInternal(req: PreviewInvoke, signal: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    const { key, method } = req;
    const args = req.args ?? {};
    if (method === 'open') return this.open(key, args, signal);
    // Standalone offscreen capture — no per-key window involved.
    if (method === 'thumbnail') {
      const { captureThumbnail } = await import('./thumbnail.js');
      return captureThumbnail({
        url: String(args.url ?? ''),
        outPath: String(args.outPath ?? ''),
        width: typeof args.width === 'number' ? args.width : undefined,
        thumbWidth: typeof args.thumbWidth === 'number' ? args.thumbWidth : undefined,
      });
    }

    if (method === 'close') {
      this.closeKey(key);
      return { ok: true };
    }
    // Backend lifecycle (not agent-facing): closeWindow frees the window but
    // keeps the owned dev server for reuse; closeSession also stops it.
    if (method === 'closeWindow') {
      this.closeKey(key);
      return { ok: true };
    }
    if (method === 'closeSession') {
      await this.closeSession(key);
      return { ok: true };
    }
    if (method === 'closeWindowPrefix') {
      this.closePrefix(key);
      return { ok: true };
    }
    if (method === 'closeSessionPrefix') {
      await this.closeSessionPrefix(key);
      return { ok: true };
    }
    const pw = this.byKey.get(key);
    if (!pw || pw.win.isDestroyed()) {
      throw new Error('No preview window open for this agent. Call preview_open first.');
    }

    if (
      method === 'click' || method === 'type' || method === 'fill' || method === 'wait_for' ||
      method === 'press' || method === 'scroll' || method === 'hover' ||
      method === 'double_click' || method === 'right_click'
    ) {
      const cursor = pw.getCursor();
      const result = await dispatchInteraction(pw, method, args, signal);
      throwIfAborted(signal);
      const page = await pw.getPageState();
      const diagnostics = pw.getDiagnosticsSince(cursor);
      return { ...(result as object), page, diagnostics };
    }

    switch (method) {
      case 'viewport': {
        const v = applyViewport(pw, resolveViewport(args, pw.viewport));
        return { ok: true, viewport: v };
      }
      case 'navigate':
        pw.clearBuffers();
        await this.loadUrl(pw.win, requireAllowedPreviewUrl(String(args.url ?? '')), signal);
        pw.url = pw.win.webContents.getURL();
        return { ok: true, url: pw.url };
      case 'console':
        if (args.waitMs) await pw.waitFor('console', () => true, Number(args.waitMs), signal);
        {
          const all = pw.getConsole(args.level as string | undefined);
          const limit = boundedCount(args.limit, 50);
          return {
            logs: all.slice(-limit),
            ...(all.length > limit
              ? {
                  sourceTruncations: [{
                    technique: 'preview-console-window',
                    inputSize: all.length,
                    outputSize: limit,
                    unit: 'items',
                    recoverable: true,
                  }],
                }
              : {}),
          };
        }
      case 'network': {
        if (args.waitForMs) {
          await pw.waitFor('network', (e) => {
            const n = e as { url: string; completed?: boolean; failed?: boolean };
            return (!args.urlFilter || n.url.includes(String(args.urlFilter))) && (!!n.completed || !!n.failed);
          }, Number(args.waitForMs), signal);
        }
        const allRequests = pw.getNetwork({ urlFilter: args.urlFilter as string, status: args.status as number });
        const limit = boundedCount(args.limit, 60);
        let requests = allRequests.slice(-limit).map((entry) => ({ ...entry }));
        const sourceTruncations: Array<{
          technique: string;
          inputSize: number;
          outputSize: number;
          unit: 'chars' | 'items';
          recoverable: boolean;
        }> = [];
        if (allRequests.length > limit) {
          sourceTruncations.push({
            technique: 'preview-network-window',
            inputSize: allRequests.length,
            outputSize: limit,
            unit: 'items',
            recoverable: true,
          });
        }
        if (args.includeBody) {
          // Best-effort: response bodies are only retained by CDP for a window
          // and only for finished responses. Keep a configurable safety bound
          // per body and report every omission structurally to the runner.
          const bodyMaxChars = boundedCount(
            args.bodyMaxChars,
            PREVIEW_BODY_DEFAULT_CHARS,
            PREVIEW_BODY_MAX_CHARS,
          );
          const bodyTotalMaxChars = boundedCount(
            args.bodyTotalMaxChars,
            PREVIEW_BODY_TOTAL_DEFAULT_CHARS,
            PREVIEW_BODY_TOTAL_MAX_CHARS,
          );
          let bodyRemaining = bodyTotalMaxChars;
          let cappedBodyInput = 0;
          let cappedBodyOutput = 0;
          let binaryBodyInput = 0;
          // Query sequentially: it keeps the aggregate budget deterministic
          // and avoids flooding one debugger session with dozens of parallel
          // Network.getResponseBody commands.
          for (const r of requests) {
            try {
              if (!r.completed) {
                r.body = '[body unavailable: request has not finished]';
                continue;
              }
              const b = (await pw.send('Network.getResponseBody', { requestId: r.requestId })) as { body?: string; base64Encoded?: boolean };
              if (!b?.body) continue;
              if (b.base64Encoded) {
                binaryBodyInput += b.body.length;
                r.body = '[binary body omitted]';
                continue;
              }
              const allowed = Math.max(0, Math.min(bodyMaxChars, bodyRemaining));
              if (allowed === 0) {
                cappedBodyInput += b.body.length;
                r.body = '[body omitted: aggregate response-body budget exhausted]';
              } else if (b.body.length > allowed) {
                bodyRemaining -= allowed;
                cappedBodyInput += b.body.length;
                cappedBodyOutput += allowed;
                r.body = `${b.body.slice(0, allowed)}\n[body capped at ${allowed} chars; use a narrower URL filter or a larger aggregate budget]`;
              } else {
                bodyRemaining -= b.body.length;
                r.body = b.body;
              }
            } catch (error) {
              r.body = `[body unavailable: ${error instanceof Error ? error.message : String(error)}]`;
            }
          }
          if (cappedBodyInput > 0) {
            sourceTruncations.push({
              technique: 'preview-response-body-cap',
              inputSize: cappedBodyInput,
              outputSize: cappedBodyOutput,
              unit: 'chars',
              recoverable: true,
            });
          }
          if (binaryBodyInput > 0) {
            sourceTruncations.push({
              technique: 'preview-binary-body-omitted',
              inputSize: binaryBodyInput,
              outputSize: 0,
              unit: 'chars',
              recoverable: false,
            });
          }
        }
        return {
          requests,
          ...(sourceTruncations.length > 0 ? { sourceTruncations } : {}),
        };
      }
      case 'eval': {
        const timeoutMs = Math.min(30_000, Math.max(100, Number(args.timeoutMs) || 10_000));
        const r = (await pw.send('Runtime.evaluate', {
          expression: String(args.js ?? ''),
          returnByValue: true,
          awaitPromise: true,
          replMode: true,
          timeout: timeoutMs,
        })) as { result?: { value?: unknown; description?: string }; exceptionDetails?: unknown };
        if (r.exceptionDetails) return { error: JSON.stringify(r.exceptionDetails) };
        return { value: r.result?.value ?? r.result?.description ?? null };
      }
      case 'screenshot': {
        // Optional `clip` ({x,y,width,height}) crops to a region — used by the
        // dashboard's region-select to capture exactly the drawn box.
        const clip = (args.clip as { x: number; y: number; width: number; height: number } | undefined) ?? null;
        const params: Record<string, unknown> = {
          format: 'png',
          captureBeyondViewport: !!args.fullPage,
        };
        if (clip && clip.width > 0 && clip.height > 0) {
          params.clip = {
            x: Math.round(clip.x),
            y: Math.round(clip.y),
            width: Math.round(clip.width),
            height: Math.round(clip.height),
            scale: 1,
          };
        } else if (args.fullPage) {
          const metrics = (await pw.send('Page.getLayoutMetrics', {})) as {
            cssContentSize?: { x?: number; y?: number; width?: number; height?: number };
          };
          const content = metrics.cssContentSize;
          if (content?.width && content?.height) {
            params.clip = {
              x: Math.max(0, content.x ?? 0),
              y: Math.max(0, content.y ?? 0),
              width: Math.min(16_384, Math.max(1, content.width)),
              height: Math.min(16_384, Math.max(1, content.height)),
              scale: 1,
            };
          }
        }
        const r = (await pw.send('Page.captureScreenshot', params)) as { data?: string };
        return { base64: r.data };
      }
      case 'inspect_css': {
        const doc = (await pw.send('DOM.getDocument', {})) as { root?: { nodeId?: number } };
        const q = (await pw.send('DOM.querySelector', { nodeId: doc.root?.nodeId, selector: String(args.selector ?? '') })) as { nodeId?: number };
        if (!q.nodeId) return { error: 'no element matched the selector' };
        const computed = await pw.send('CSS.getComputedStyleForNode', { nodeId: q.nodeId }).catch(() => null);
        const matched = await pw.send('CSS.getMatchedStylesForNode', { nodeId: q.nodeId }).catch(() => null);
        return { computed, matched };
      }
      case 'performance': {
        const [metrics, navigation] = await Promise.all([
          pw.send('Performance.getMetrics', {}),
          pw.send('Runtime.evaluate', {
            expression: '(()=>{const n=performance.getEntriesByType("navigation")[0];return n&&n.toJSON?n.toJSON():null})()',
            returnByValue: true,
          }).catch(() => null),
        ]);
        return {
          metrics,
          navigation: (navigation as { result?: { value?: unknown } } | null)?.result?.value ?? null,
        };
      }
      case 'memory':
        return { memory: await pw.send('Runtime.getHeapUsage', {}) };
      case 'storage': {
        const kind = String(args.kind ?? 'local');
        if (kind === 'cookies') {
          // Network.getCookies includes httpOnly cookies that document.cookie
          // can't see; fall back to document.cookie if the domain has none.
          try {
            const c = (await pw.send('Network.getCookies', {})) as { cookies?: unknown[] };
            const cookies = (c.cookies ?? []).map((cookie) => {
              if (!cookie || typeof cookie !== 'object') return cookie;
              return { ...(cookie as Record<string, unknown>), value: '[redacted]' };
            });
            return { kind, data: cookies, valuesRedacted: true };
          } catch { /* fall through to document.cookie */ }
        }
        const expr =
          kind === 'cookies' ? 'document.cookie'
          : kind === 'session' ? 'Object.assign({},sessionStorage)'
          : kind === 'indexeddb' ? '(async()=>((indexedDB.databases?await indexedDB.databases():[]).map(d=>d.name)))()'
          : 'Object.assign({},localStorage)';
        const r = (await pw.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })) as { result?: { value?: unknown } };
        const value = r.result?.value;
        if ((kind === 'local' || kind === 'session') && value && typeof value === 'object') {
          const data = Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, item]) => [
              key,
              /token|secret|password|passcode|auth|cookie|session/i.test(key) ? '[redacted]' : item,
            ]),
          );
          return { kind, data, sensitiveValuesRedacted: true };
        }
        return { kind, data: kind === 'cookies' && typeof value === 'string' ? '[redacted]' : value };
      }
      case 'snapshot':
        return this.snapshot(pw, args);
      default:
        throw new Error(`unknown preview method: ${method}`);
    }
  }

  private async snapshot(pw: PreviewWindow, args: Record<string, unknown>): Promise<unknown> {
    type AxValue = { value?: unknown };
    type AxNode = {
      nodeId: string;
      ignored?: boolean;
      role?: AxValue;
      name?: AxValue;
      value?: AxValue;
      properties?: Array<{ name?: string; value?: AxValue }>;
      childIds?: string[];
      backendDOMNodeId?: number;
    };
    const response = (await pw.send('Accessibility.getFullAXTree', {})) as { nodes?: AxNode[] };
    const all = response.nodes ?? [];
    const byId = new Map(all.map((node) => [node.nodeId, node]));
    const depthById = new Map<string, number>();
    const visit = (id: string, depth: number): void => {
      if (depthById.has(id)) return;
      depthById.set(id, depth);
      for (const childId of byId.get(id)?.childIds ?? []) visit(childId, depth + 1);
    };
    if (all[0]) visit(all[0].nodeId, 0);
    const maxDepth = boundedCount(args.maxDepth, 12, 40);
    const limit = boundedCount(args.limit, 200, 500);
    const interactiveOnly = args.interactiveOnly === true;
    const usefulRoles = new Set([
      'alert', 'banner', 'button', 'checkbox', 'combobox', 'complementary', 'contentinfo', 'dialog',
      'form', 'heading', 'img', 'link', 'listbox', 'main', 'menuitem', 'menuitemcheckbox',
      'menuitemradio', 'navigation', 'option', 'radio', 'region', 'searchbox', 'slider', 'spinbutton',
      'status', 'switch', 'tab', 'table', 'textbox', 'treeitem',
    ]);
    const interactiveRoles = new Set([
      'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'menuitemcheckbox',
      'menuitemradio', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab',
      'textbox', 'treeitem',
    ]);
    pw.resetRefs();
    const eligible = all.filter((node) => {
      if (node.ignored) return false;
      const depth = depthById.get(node.nodeId) ?? 0;
      const role = String(node.role?.value ?? '');
      if (depth > maxDepth || !node.backendDOMNodeId) return false;
      return interactiveOnly ? interactiveRoles.has(role) : usefulRoles.has(role);
    });
    const nodes = eligible.slice(0, limit).map((node) => {
      const states = Object.fromEntries(
        (node.properties ?? [])
          .filter((property) => ['checked', 'disabled', 'expanded', 'focused', 'pressed', 'required', 'selected'].includes(property.name ?? ''))
          .map((property) => [property.name!, property.value?.value]),
      );
      const role = String(node.role?.value ?? 'generic');
      const name = String(node.name?.value ?? '').trim();
      const rawValue = node.value?.value != null ? String(node.value.value) : undefined;
      const value = rawValue != null && /password|passcode|token|secret|senha/i.test(name) ? '[redacted]' : rawValue;
      return {
        ref: pw.bindRef(node.backendDOMNodeId!),
        depth: depthById.get(node.nodeId) ?? 0,
        role,
        name,
        ...(value != null ? { value } : {}),
        ...(Object.keys(states).length ? { states } : {}),
      };
    });
    const page = await pw.getPageState();
    return {
      page,
      nodes,
      ...(eligible.length > limit
        ? {
            sourceTruncations: [{
              technique: 'preview-accessibility-window',
              inputSize: eligible.length,
              outputSize: limit,
              unit: 'items',
              recoverable: true,
            }],
          }
        : {}),
    };
  }

  private async open(
    key: string,
    args: Record<string, unknown> = {},
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ windowId: number; url: string; viewport: Viewport; reused: boolean; source: 'explicit' | 'reused' | 'started' }> {
    throwIfAborted(signal);
    const initial = resolveViewport(args, DEFAULT_VIEWPORT);
    // Resolve the URL: explicit `url` wins; otherwise reuse/start the
    // project's dev server via the runner (and remember ownership so we
    // can stop exactly what we started, never the user's runner).
    let url = String(args.url ?? '').trim();
    let reused = true;
    let startedTaskId: string | undefined;
    let source: 'explicit' | 'reused' | 'started' = url ? 'explicit' : 'reused';
    if (!url) {
      const projectId = typeof args.projectId === 'number' ? args.projectId : null;
      if (projectId == null || !this.runnerBridge) {
        throw new Error(
          'preview_open needs a `url` (no project dev-server resolver available here). ' +
            'Pass url=http://localhost:PORT.',
        );
      }
      const resolved = await resolveDevUrl(this.runnerBridge, projectId, { signal });
      url = resolved.url;
      reused = !resolved.ownedTaskId;
      source = resolved.ownedTaskId ? 'started' : 'reused';
      if (resolved.ownedTaskId) {
        startedTaskId = resolved.ownedTaskId;
        this.ownedTaskByKey.set(key, resolved.ownedTaskId);
      }
    }
    const stopServerStartedByThisOpen = async (): Promise<void> => {
      if (!startedTaskId || this.ownedTaskByKey.get(key) !== startedTaskId) return;
      this.ownedTaskByKey.delete(key);
      if (this.runnerBridge) await this.runnerBridge.stop(startedTaskId).catch(() => undefined);
    };
    try {
      url = requireAllowedPreviewUrl(url);
    } catch (error) {
      await stopServerStartedByThisOpen();
      throw error;
    }
    if (signal.aborted) {
      await stopServerStartedByThisOpen();
      throw abortError();
    }
    const existing = this.byKey.get(key);
    if (existing && !existing.win.isDestroyed()) {
      try {
        existing.clearBuffers();
        await this.loadUrl(existing.win, url, signal);
        existing.url = existing.win.webContents.getURL();
        const v = applyViewport(existing, initial);
        return { windowId: existing.id, url: existing.url, viewport: v, reused, source };
      } catch (error) {
        await stopServerStartedByThisOpen();
        throw error;
      }
    }
    const { width, height } = clampToScreen(initial.width, initial.height);
    const appIconPath = resolveAppIconPath();
    const win = new BrowserWindow({
      width,
      height,
      title: `Preview · ${key}`,
      ...(appIconPath ? { icon: appIconPath } : {}),
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: partitionForKey(key),
        backgroundThrottling: false,
      },
    });
    this.configureSession(win.webContents.session);
    win.webContents.setWindowOpenHandler(({ url: requestedUrl }) => {
      if (isAllowedPreviewUrl(requestedUrl)) {
        void this.loadUrl(win, requestedUrl, new AbortController().signal).catch(() => undefined);
      }
      return { action: 'deny' };
    });
    const guardNavigation = (event: { preventDefault(): void }, requestedUrl: string): void => {
      if (!isAllowedPreviewUrl(requestedUrl)) event.preventDefault();
    };
    win.webContents.on('will-navigate', guardNavigation);
    win.webContents.on('will-redirect', guardNavigation);
    win.on('closed', () => {
      if (this.byKey.get(key)?.id === win.id) {
        // Tell the dashboard the window is gone (native X or toolbar close) so
        // it can un-pause the inline iframe. Harmless for agent keys (no listeners).
        this.fanoutSelect(key, { type: 'mcp:closed' });
        this.byKey.delete(key);
        this.inspectListeners.delete(key);
      }
    });
    let pw: PreviewWindow | null = null;
    try {
      pw = await PreviewWindow.create(win, url, () => this.loadUrl(win, url, signal));
      this.byKey.set(key, pw);
      pw.url = win.webContents.getURL();
      const viewport = applyViewport(pw, initial);
      return { windowId: pw.id, url: pw.url, viewport, reused, source };
    } catch (error) {
      this.byKey.delete(key);
      if (pw) pw.close();
      else if (!win.isDestroyed()) win.destroy();
      await stopServerStartedByThisOpen();
      throw error;
    }
  }

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

  private fanoutSelect(key: string, d: unknown): void {
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
    const res = await this.open(key, { url });
    const pw = this.byKey.get(key);
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
    const pw = this.byKey.get(key);
    if (pw && !pw.win.isDestroyed()) {
      const m = mode === 'react' || mode === 'universal' ? mode : 'auto';
      await pw.setSelectorMode(m);
    }
  }

  async disarmInspect(key: string): Promise<void> {
    const pw = this.byKey.get(key);
    if (pw && !pw.win.isDestroyed()) await pw.disarmInspect();
  }

  /** Bring the inspect window to the front (dashboard "Focus"). */
  focusInspect(key: string): void {
    const pw = this.byKey.get(key);
    if (pw && !pw.win.isDestroyed()) { try { pw.win.focus(); } catch { /* gone */ } }
  }

  /** Control-bar actions from the injected toolbar (`viewport:<preset>`, `close`). */
  private handleControl(key: string, action: string): void {
    if (action === 'close') { this.closeKey(key); return; }
    if (action.startsWith('viewport:')) {
      const vp = VIEWPORT_PRESETS[action.slice('viewport:'.length)];
      const pw = this.byKey.get(key);
      if (pw && vp) applyViewport(pw, vp);
    }
  }

  private configureSession(ses: Session): void {
    if (this.configuredSessions.has(ses)) return;
    this.configuredSessions.add(ses);
    ses.setPermissionCheckHandler(() => false);
    ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    ses.on('will-download', (event) => event.preventDefault());
  }

  private loadUrl(win: BrowserWindow, url: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = (): void => {
        try { win.webContents.stop(); } catch { /* gone */ }
        finish(abortError());
      };
      const timer = setTimeout(() => {
        try { win.webContents.stop(); } catch { /* gone */ }
        finish(new Error(`Preview navigation timed out after 30s: ${url}`));
      }, 30_000);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      win.loadURL(url).then(
        () => finish(),
        (error) => finish(error),
      );
    });
  }

  closeKey(key: string): void {
    // Notify the dashboard BEFORE teardown; delete synchronously so a quick
    // re-open never reuses a closing window. The window 'closed' handler then
    // no-ops (byKey already cleared), so the sentinel fires exactly once.
    // NOTE: leaves ownedTaskByKey intact — the owned dev server survives a
    // window close (turn end) for reuse; only closeSession stops it.
    this.fanoutSelect(key, { type: 'mcp:closed' });
    this.byKey.get(key)?.close();
    this.byKey.delete(key);
    this.inspectListeners.delete(key);
  }

  private matchingKeys(prefix: string): string[] {
    const all = new Set([...this.byKey.keys(), ...this.ownedTaskByKey.keys()]);
    return Array.from(all).filter((key) => key === prefix || key.startsWith(`${prefix}-`));
  }

  private closePrefix(prefix: string): void {
    for (const key of this.matchingKeys(prefix)) this.closeKey(key);
  }

  private async closeSessionPrefix(prefix: string): Promise<void> {
    await Promise.all(this.matchingKeys(prefix).map((key) => this.closeSession(key)));
  }

  /** Session evict: close the window AND stop the dev server we started for
   *  it (if any). The user's own runner is never owned, so it stays up. */
  async closeSession(key: string): Promise<void> {
    this.closeKey(key);
    const taskId = this.ownedTaskByKey.get(key);
    this.ownedTaskByKey.delete(key);
    if (taskId && this.runnerBridge) {
      try {
        await this.runnerBridge.stop(taskId);
      } catch {
        /* runner already gone — best-effort */
      }
    }
    try {
      await session.fromPartition(partitionForKey(key)).clearStorageData();
    } catch {
      /* in-memory preview partition already gone */
    }
  }

  async closeAll(): Promise<void> {
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    for (const pw of this.byKey.values()) pw.close();
    this.byKey.clear();
    this.inspectListeners.clear();
    // Stop every preview-owned dev server before the runner worker pool goes
    // away. Awaiting this prevents a late stop request from racing app exit.
    const ownedTasks = [...this.ownedTaskByKey.values()];
    this.ownedTaskByKey.clear();
    if (this.runnerBridge) {
      await Promise.allSettled(ownedTasks.map((taskId) => this.runnerBridge!.stop(taskId)));
    }
  }
}
