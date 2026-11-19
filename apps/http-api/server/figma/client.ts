const API = 'https://api.figma.com/v1/';
const JSON_LIMIT = 16 * 1024 * 1024;
const IMAGE_LIMIT = 6 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

export class FigmaApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function apiError(response: Response, scope: string): FigmaApiError {
  const { status } = response;
  if (status === 401 || status === 403) {
    return new FigmaApiError(status,
      `Figma denied access (HTTP ${status}). Check that the token is valid, includes ${scope}, and has access to this resource.`);
  }
  if (status === 404) return new FigmaApiError(status, 'Figma could not find this file or resource. Check the link and your access.');
  if (status === 429) {
    const seconds = Number(response.headers.get('Retry-After'));
    const delay = Number.isSafeInteger(seconds) && seconds > 0 ? ` Retry after ${seconds} seconds.` : '';
    return new FigmaApiError(status, 'Figma rate limit reached.' + delay);
  }
  return new FigmaApiError(status, `Figma returned HTTP ${status}. Use a smaller selection if the request covered many layers.`);
}

async function readBody(response: Response, limit: number, tooLarge: string): Promise<Buffer> {
  if (Number(response.headers.get('Content-Length')) > limit) {
    await response.body?.cancel();
    throw new Error(tooLarge);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return Buffer.concat(chunks, size);
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error(tooLarge);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function exportUrl(value: unknown): URL {
  if (typeof value !== 'string') throw new Error('Figma could not render this layer.');
  const url = new URL(value);
  const host = url.hostname;
  const assetHost = host.endsWith('.figma.com') || host.endsWith('.figmausercontent.com')
    || /^figma-[a-z0-9-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !assetHost) {
    throw new Error('Figma returned an unsupported asset URL.');
  }
  return url;
}

export class FigmaClient {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}

  private async get(path: string, scope: string, signal?: AbortSignal, params?: Record<string, string>): Promise<JsonObject> {
    const url = new URL(API + path);
    if (params) url.search = new URLSearchParams(params).toString();
    const timeout = AbortSignal.timeout(25_000);
    const response = await this.fetcher(url, {
      headers: { 'X-Figma-Token': this.token, Accept: 'application/json' },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw apiError(response, scope);
    }
    const body = await readBody(response, JSON_LIMIT, 'Figma response is too large. Request a smaller layer selection or depth.');
    return object(JSON.parse(body.toString('utf8')));
  }

  async account(signal?: AbortSignal): Promise<string> {
    const result = await this.get('me', 'current_user:read', signal);
    if (typeof result.id !== 'string' && typeof result.id !== 'number' && typeof result.handle !== 'string') {
      throw new Error('Figma returned an unexpected account response.');
    }
    return typeof result.handle === 'string' && result.handle.trim() ? result.handle.slice(0, 160) : 'Figma';
  }

  file(key: string, depth: number, signal?: AbortSignal) {
    return this.get(`files/${key}`, 'file_content:read', signal, { depth: String(depth) });
  }

  nodes(key: string, ids: string[], depth: number, signal?: AbortSignal) {
    return this.get(`files/${key}/nodes`, 'file_content:read', signal, { ids: ids.join(','), depth: String(depth) });
  }

  async exports(key: string, ids: string[], format: string, scale: number, signal?: AbortSignal) {
    const result = await this.get(`images/${key}`, 'file_content:read', signal, {
      ids: ids.join(','), format, scale: String(scale),
    });
    const images = object(result.images);
    return ids.map(id => ({ nodeId: id, url: typeof images[id] === 'string' ? exportUrl(images[id]).href : null }));
  }

  async screenshot(url: string, signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(20_000);
    // CDN requests intentionally carry no Figma credentials.
    const response = await this.fetcher(exportUrl(url), {
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new FigmaApiError(response.status, `Figma image download failed (HTTP ${response.status}).`);
    }
    const png = await readBody(response, IMAGE_LIMIT, 'Screenshot exceeds 6 MiB. Try a smaller frame or a lower scale.');
    if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error('Figma returned an invalid PNG screenshot.');
    }
    return png.toString('base64');
  }

  variables(key: string, signal?: AbortSignal) {
    return this.get(`files/${key}/variables/local`, 'file_variables:read and Enterprise Full seat access', signal);
  }
}
