import type { PreviewInvoke } from '@mcp/code-agent/tools/preview/index.js';
import type { PreviewWindow } from './cdp.js';

const PREVIEW_BODY_DEFAULT_CHARS = 20_000;
const PREVIEW_BODY_MAX_CHARS = 200_000;
const PREVIEW_BODY_TOTAL_DEFAULT_CHARS = 200_000;
const PREVIEW_BODY_TOTAL_MAX_CHARS = 2_000_000;

function boundedCount(value: unknown, fallback: number, max = 250): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(parsed, max));
}

export async function dispatchPreviewQuery(pw: PreviewWindow, method: PreviewInvoke['method'], args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    switch (method) {
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
        return snapshot(pw, args);
      default:
        throw new Error(`unknown preview method: ${method}`);
    }
  }

async function snapshot(pw: PreviewWindow, args: Record<string, unknown>): Promise<unknown> {
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

