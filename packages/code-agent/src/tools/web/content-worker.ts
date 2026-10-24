import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export interface SearchResult { title: string; url: string; snippet: string }
export type WebContentKind = 'html' | 'json' | 'brave' | 'duckduckgo';
let active = 0;
const SOURCE = String.raw`
const { parentPort, workerData: d } = require('node:worker_threads');
try {
  const Turndown = require(d.turndown); const td = new Turndown({ codeBlockStyle: 'fenced', headingStyle: 'atx', bulletListMarker: '-' });
  td.use(require(d.gfm).gfm); td.remove(['script', 'style', 'noscript']);
  const markdown = html => td.turndown(String(html)).replace(/\n{3,}/g, '\n\n').trim();
  let result;
  if (d.kind === 'html') result = markdown(d.text);
  else if (d.kind === 'json') { try { result = JSON.stringify(JSON.parse(d.text), null, 2); } catch { result = d.text; } }
  else if (d.kind === 'brave') {
    const data = JSON.parse(d.text);
    if (data.web?.results != null && !Array.isArray(data.web.results)) throw new Error('Invalid Brave response');
    result = (data.web?.results ?? []).slice(0, 10).map(r => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), snippet: markdown(r.description ?? '') }));
  } else {
    result = [];
    const re = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = re.exec(d.text)) !== null && result.length < 10) {
      let url = match[1].replace(/&amp;/g, '&');
      try { const parsed = new URL(url, 'https://duckduckgo.com'); url = parsed.searchParams.get('uddg') ?? parsed.href; } catch {}
      result.push({ title: markdown(match[2]), url, snippet: markdown(match[3]) });
    }
  }
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error('Converted web content exceeds 16 MiB');
  parentPort.postMessage({ serialized });
} catch (error) { parentPort.postMessage({ error: String(error.message || error) }); }
parentPort.close();
`;

/** HTML/JSON parsing never blocks the conversation's event loop. This worker
 * executes only constant conversion code; page scripts are never evaluated. */
export async function convertWebContent(kind: WebContentKind, text: string, signal?: AbortSignal): Promise<string | SearchResult[]> {
  signal?.throwIfAborted();
  if (Buffer.byteLength(text) > 10 * 1024 * 1024) throw new Error('Web conversion input exceeds 10 MiB');
  if (active >= 8) throw new Error('Web converter is saturated');
  active++; let worker: Worker | undefined;
  try {
    worker = new Worker(SOURCE, { eval: true, workerData: { kind, text,
      turndown: require.resolve('turndown'), gfm: require.resolve('turndown-plugin-gfm') },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
    const result = await new Promise<string | SearchResult[]>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, serialized?: string) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) { reject(error); return; }
        try { resolve(JSON.parse(serialized!)); } catch (cause) { reject(cause); }
      };
      const abort = () => finish(signal?.reason ?? new Error('Web conversion cancelled'));
      const timer = setTimeout(() => finish(new Error('Web conversion exceeded 5 seconds')), 5000);
      worker!.once('message', message => finish(message.error ? new Error(message.error) : undefined, message.serialized));
      worker!.once('error', error => finish(error));
      worker!.once('exit', code => finish(new Error(`Web converter exited before result (${code})`)));
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    });
    signal?.throwIfAborted(); return result;
  } finally { try { if (worker) await worker.terminate(); } finally { active--; } }
}
