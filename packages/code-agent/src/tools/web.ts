import { createHash } from 'node:crypto';
import { isPrivateHost } from '@mcp/shared/utils/ssrf.js';
import { readPublicWeb, validatePublicWebUrl, type PublicWebResponse } from '@mcp/shared/utils/public-web-request.js';
import type { CoderTool, ToolContext, ToolResult, ToolSourceTruncation } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { combinedMutationSignal } from '@mcp/code-agent/core/mutation-fence.js';
import { convertWebContent, type SearchResult } from './web/content-worker.js';
import { webCacheGet, webCachePut } from './web/cache.js';

export const isBlockedFetchHost = isPrivateHost;
const DEFAULT_BYTES = 2 * 1024 * 1024;
const MAX_BYTES = 10 * 1024 * 1024;
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function invocation(ctx: ToolContext) {
  const signal = combinedMutationSignal(ctx.signal, ctx.mutationFence);
  const check = () => { signal?.throwIfAborted(); ctx.ports?.web?.assertCurrent(); };
  const read = async (url: string, maxBytes: number, headers?: Record<string, string>): Promise<PublicWebResponse> => {
    check();
    const input = { url, maxBytes, headers, signal, assertCurrent: check };
    const result = await (ctx.ports?.web ? ctx.ports.web.read(input) : readPublicWeb(input));
    check(); return result;
  };
  const cc = ctx.companyContext as { agentRunId?: string } | undefined;
  const scope = [ctx.projectId ?? '', ctx.sessionId ?? '', cc?.agentRunId ?? ''].join(':');
  return { signal, check, read, scope };
}

export const webFetch: CoderTool = {
  name: 'web_fetch', source: 'native', mutates: false, parallelSafe: true, riskLevel: 'read',
  description: 'Read a public HTTP/HTTPS page as markdown or text. Use for documentation, changelogs, or a URL the user cited. ' +
    'Follows up to five validated redirects. Private hosts, private DNS answers, URL credentials and HTTPS downgrade redirects are refused; ' +
    'use http_request for local backends. Acquisition is bounded and truncated sources are marked. Large acquired results remain recoverable with get_tool_output. ' +
    'Small pages are cached for 15 minutes within the session.',
  outputPolicy: { mode: 'structured', reducer: 'smart', recovery: 'output_store', preserveOnError: true },
  parameters: { type: 'object', properties: {
    url: { type: 'string', description: 'Full public http:// or https:// URL.' },
    max_bytes: { type: 'number', description: 'Acquisition ceiling for decoded bytes (default 2 MiB, max 10 MiB).' },
  }, required: ['url'], additionalProperties: false },
  handler: async (args, ctx): Promise<ToolResult> => {
    try {
      const call = invocation(ctx); call.check();
      const url = validatePublicWebUrl(String(args.url ?? '').trim());
      const requested = Number(args.max_bytes ?? DEFAULT_BYTES);
      const maxBytes = Number.isFinite(requested) ? Math.min(MAX_BYTES, Math.max(1024, Math.floor(requested))) : DEFAULT_BYTES;
      const key = call.scope + ':fetch:' + url.href + '|' + maxBytes;
      const hit = webCacheGet(key);
      if (hit) return { content: hit.text + '\n\n[cached]', sourceTruncations: hit.sourceTruncations };
      const acquired = await call.read(url.href, maxBytes);
      if (acquired.status < 200 || acquired.status >= 300) return err('web_fetch: HTTP ' + acquired.status + ' ' + acquired.statusText + ' for ' + acquired.url);
      const contentType = acquired.contentType.toLowerCase();
      const kind = contentType.includes('application/json') ? 'json' : contentType.includes('text/html') || /<html[\s>]/i.test(acquired.text) ? 'html' : undefined;
      const body = kind ? await convertWebContent(kind, acquired.text, call.signal) as string : acquired.text;
      call.check();
      const marker = acquired.truncated
        ? '\n\n[source truncated: web transfer stopped at max_bytes=' + maxBytes + '; source size ' +
          (acquired.inputSizeExact ? 'was ' : 'is at least ') + acquired.inputBytes + ' bytes. Retry a narrower resource or raise max_bytes.]' : '';
      const out = '# ' + acquired.url + '\n\nContent-Type: ' + (acquired.contentType || '(unknown)') + '\n\n---\n\n' + body + marker;
      const sourceTruncations: ToolSourceTruncation[] | undefined = acquired.truncated ? [{ technique: 'network-acquisition-cap',
        inputSize: acquired.inputBytes, ...(acquired.inputSizeExact ? {} : { inputSizeExact: false }),
        outputSize: Buffer.byteLength(acquired.text), unit: 'bytes', recoverable: false }] : undefined;
      webCachePut(key, out, sourceTruncations);
      return { content: out, sourceTruncations };
    } catch (cause) { return err('web_fetch failed: ' + message(cause)); }
  },
};

function domains(input: unknown): string[] {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 50) throw new Error('Domain filters require at most 50 hostnames');
  return input.map(value => {
    const text = String(value).trim().toLowerCase().replace(/\.$/, '');
    const parsed = new URL('https://' + text);
    if (!text || parsed.hostname !== text || parsed.port || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('Domain filters must contain hostnames, without URLs or paths');
    }
    return parsed.hostname;
  });
}
function filterResults(results: SearchResult[], allow: string[], block: string[]): SearchResult[] {
  return results.filter(result => {
    let url: URL; try { url = validatePublicWebUrl(result.url); } catch { return false; }
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const matches = (domain: string) => host === domain || host.endsWith('.' + domain);
    return (!allow.length || allow.some(matches)) && !block.some(matches);
  });
}

export const webSearch: CoderTool = {
  name: 'web_search', source: 'native', mutates: false, parallelSafe: true, riskLevel: 'read',
  description: 'Search the public web for documentation, changelogs and relevant pages. Follow results with web_fetch for full text. ' +
    'Uses Brave when BRAVE_API_KEY is configured, otherwise DuckDuckGo. Small results are cached for 15 minutes within the session.',
  outputPolicy: { mode: 'search', reducer: 'smart', recovery: 'rerun' },
  parameters: { type: 'object', properties: {
    query: { type: 'string', description: 'Search terms (up to 4096 characters).' },
    allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Allow these exact hostnames and their subdomains, e.g. ["python.org"].' },
    blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Exclude these exact hostnames and their subdomains.' },
  }, required: ['query'], additionalProperties: false },
  handler: async (args, ctx): Promise<ToolResult> => {
    try {
      const call = invocation(ctx); call.check();
      const query = String(args.query ?? '').trim();
      if (!query || query.length > 4096) return err('query must contain between 1 and 4096 characters');
      const allow = domains(args.allowed_domains), block = domains(args.blocked_domains);
      const braveKey = process.env.BRAVE_API_KEY;
      const backendKey = braveKey ? createHash('sha256').update(braveKey).digest('hex') : 'duckduckgo';
      const key = call.scope + ':search:' + backendKey + ':' + JSON.stringify([query, allow, block]);
      const hit = webCacheGet(key); if (hit) return ok(hit.text + '\n\n[cached]');
      const search = async (brave: boolean) => {
        const url = brave ? 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=10'
          : 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
        const acquired = await call.read(url, DEFAULT_BYTES, brave ? { 'X-Subscription-Token': braveKey!, Accept: 'application/json' } : undefined);
        if (acquired.status < 200 || acquired.status >= 300) throw new Error('Search backend HTTP ' + acquired.status);
        if (acquired.truncated) throw new Error('Search response exceeds acquisition ceiling');
        return await convertWebContent(brave ? 'brave' : 'duckduckgo', acquired.text, call.signal) as SearchResult[];
      };
      let backend = braveKey ? 'brave' : 'duckduckgo';
      let results: SearchResult[];
      try { results = await search(!!braveKey); }
      catch (cause) {
        call.check();
        if (!braveKey) throw cause;
        results = await search(false); backend = 'duckduckgo (brave failed)';
      }
      call.check();
      const filtered = filterResults(results, allow, block);
      const out = '[backend: ' + backend + ']\nquery: ' + query + '\n\n' + (filtered.length
        ? filtered.map((r, i) => (i + 1) + '. **' + r.title + '**\n   ' + r.url + '\n   ' + r.snippet).join('\n\n') : 'No results.');
      webCachePut(key, out); return ok(out);
    } catch (cause) { return err('web_search failed: ' + message(cause)); }
  },
};

export const webTools: CoderTool[] = [webFetch, webSearch];
