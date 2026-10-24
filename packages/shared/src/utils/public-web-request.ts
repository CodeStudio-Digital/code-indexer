import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable, Transform } from 'node:stream';
import { decodeCompleteUtf8Prefix } from './http-engine.js';
import { resolvePublicWebHost } from './public-web-dns.js';
import { isPrivateHost } from './ssrf.js';

export interface PublicWebResponse {
  url: string; status: number; statusText: string; contentType: string;
  text: string; truncated: boolean; inputBytes: number; inputSizeExact: boolean;
}
export interface PublicWebRequest {
  url: string; maxBytes: number; headers?: Record<string, string>;
  signal?: AbortSignal; assertCurrent?: () => void;
}
export function validatePublicWebUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http:// and https:// public URLs are supported');
  if (url.username || url.password) throw new Error('Credentials in public web URLs are not supported');
  if (isPrivateHost(url.hostname)) throw new Error(`refusing private/loopback host '${url.hostname}'`);
  url.hash = ''; return url;
}

/** Public GET only. Every hop closes its private socket before the next hop;
 * compressed and decoded bytes both have a ceiling. No shared cookie jar. */
export async function readPublicWeb(input: PublicWebRequest): Promise<PublicWebResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Web transfer timed out after 20000ms')), 20000);
  const signal = AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]);
  const check = () => { signal.throwIfAborted(); input.assertCurrent?.(); };
  const maxBytes = Number.isFinite(input.maxBytes) ? Math.min(10 * 1024 * 1024, Math.max(1024, Math.floor(input.maxBytes))) : 2 * 1024 * 1024;
  try {
    let url = validatePublicWebUrl(input.url);
    let headers = { ...input.headers };
    for (let hop = 0; hop <= 5; hop++) {
      check();
      const address = await resolvePublicWebHost(url.hostname, signal); check();
      const result = await readHop(url, headers, address, maxBytes, signal, check);
      if (!result.location) return result;
      if (hop === 5) throw new Error('Web redirect limit exceeded');
      const next = validatePublicWebUrl(new URL(result.location, url).href);
      // Search credentials and any future caller headers never cross origins.
      if (next.origin !== url.origin) headers = {};
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('Refusing HTTPS downgrade redirect');
      url = next;
    }
    throw new Error('Web redirect limit exceeded');
  } finally { clearTimeout(timer); controller.abort(); }
}

async function readHop(url: URL, headers: Record<string, string>, address: { address: string; family: 4 | 6 },
  maxBytes: number, signal: AbortSignal, check: () => void): Promise<PublicWebResponse & { location?: string }> {
  check();
  const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    method: 'GET', agent: false, signal, family: address.family,
    lookup: (_host, _options, callback) => callback(null, address.address, address.family),
    headers: { 'User-Agent': 'CodeStudio/1.0', Accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br', ...headers, Connection: 'close' },
  });
  const closed = new Promise<void>(resolve => req.once('close', resolve));
  let res: IncomingMessage | undefined, body: Readable | undefined;
  try {
    res = await new Promise<IncomingMessage>((resolve, reject) => {
      req.once('response', resolve); req.on('error', reject);
      try { check(); req.end(); } catch (cause) { reject(cause); }
    });
    const base = { url: url.href, status: res.statusCode ?? 0, statusText: res.statusMessage ?? '',
      contentType: String(res.headers['content-type'] ?? ''), text: '', truncated: false, inputBytes: 0, inputSizeExact: true };
    if ([301, 302, 303, 307, 308].includes(base.status) && res.headers.location) return { ...base, location: res.headers.location };
    if (base.status < 200 || base.status >= 300) return base;
    const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
    body = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : res;
    if (body === res && encoding && encoding !== 'identity') throw new Error(`Unsupported content encoding '${encoding}'`);
    if (body !== res) {
      const decoder = body;
      let wireBytes = 0;
      res.on('data', chunk => { wireBytes += chunk.length; if (wireBytes > 16 * 1024 * 1024) decoder.destroy(new Error('Compressed web transfer exceeds 16 MiB')); });
      res.on('error', error => decoder.destroy(error));
      res.pipe(decoder as Transform);
    }
    const chunks: Buffer[] = []; let kept = 0, observed = 0, truncated = false;
    for await (const chunk of body) {
      check();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      observed += bytes.length;
      const take = Math.min(bytes.length, maxBytes - kept);
      if (take > 0) { chunks.push(bytes.subarray(0, take)); kept += take; }
      if (observed > maxBytes) { truncated = true; break; }
    }
    check();
    const declared = Number(res.headers['content-length']);
    const exactHeader = body === res && /^\d+$/.test(res.headers['content-length'] ?? '') && Number.isSafeInteger(declared) && declared >= observed;
    return { ...base, text: decodeCompleteUtf8Prefix(Buffer.concat(chunks, kept)), truncated,
      inputBytes: truncated && exactHeader ? declared : observed, inputSizeExact: !truncated || exactHeader };
  } finally {
    body?.destroy(); res?.destroy(); req.destroy(); await closed;
  }
}
