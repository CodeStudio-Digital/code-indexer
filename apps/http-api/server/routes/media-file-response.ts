import path from 'node:path';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
  '.pdf': 'application/pdf',
};

export function mediaContentType(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function prepareProjectPreviewHtml(
  source: string,
  baseHref: string,
  previewRootHref: string,
): string {
  const escapedRoot = escapeAttribute(previewRootHref);
  let rewritten = source.replace(
    /(\b(?:href|src|action|formaction|poster)\s*=\s*)(["'])\/(?!\/)([^"']*)\2/gi,
    (_match, prefix: string, quote: string, target: string) =>
      `${prefix}${quote}${escapedRoot}${target}${quote}`,
  );
  rewritten = rewritten.replace(
    /url\(\s*(["']?)\/(?!\/)([^)"']+)\1\s*\)/gi,
    (_match, quote: string, target: string) => `url(${quote}${escapedRoot}${target}${quote})`,
  );
  rewritten = rewritten.replace(
    /(\bsrcset\s*=\s*)(["'])([^"']*)\2/gi,
    (_match, prefix: string, quote: string, value: string) => {
      const targets = value.split(',').map((candidate) => {
        const trimmed = candidate.trim();
        return trimmed.startsWith('/') && !trimmed.startsWith('//')
          ? `${escapedRoot}${trimmed.slice(1)}`
          : trimmed;
      });
      return `${prefix}${quote}${targets.join(', ')}${quote}`;
    },
  );

  const previewHead = [
    `<base href="${escapeAttribute(baseHref)}">`,
    '<meta name="referrer" content="no-referrer">',
  ].join('');
  if (/<head(?:\s[^>]*)?>/i.test(rewritten)) {
    return rewritten.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${previewHead}`);
  }
  if (/<html(?:\s[^>]*)?>/i.test(rewritten)) {
    return rewritten.replace(/<html(\s[^>]*)?>/i, (html) => `${html}<head>${previewHead}</head>`);
  }
  return `<head>${previewHead}</head>${rewritten}`;
}

export function prepareProjectPreviewCss(source: string, previewRootHref: string): string {
  const root = previewRootHref.endsWith('/') ? previewRootHref : `${previewRootHref}/`;
  let rewritten = source.replace(
    /url\(\s*(["']?)\/(?!\/)([^)"']+)\1\s*\)/gi,
    (_match, quote: string, target: string) => `url(${quote}${root}${target}${quote})`,
  );
  rewritten = rewritten.replace(
    /(@import\s+)(["'])\/(?!\/)([^"']+)\2/gi,
    (_match, prefix: string, quote: string, target: string) =>
      `${prefix}${quote}${root}${target}${quote}`,
  );
  return rewritten;
}

export interface ByteRange {
  start: number;
  end: number;
}

/** Parses one RFC 7233 byte range. Multiple ranges are intentionally unsupported. */
export function parseByteRange(value: string | undefined, size: number): ByteRange | null | 'invalid' {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || size <= 0) return 'invalid';

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return 'invalid';

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid';
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || start >= size
    || requestedEnd < start
  ) {
    return 'invalid';
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/** Streams a project-scoped media file without buffering it in the API process. */
export async function createMediaFileResponse(
  absolutePath: string,
  requestRange?: string,
): Promise<Response> {
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });

  const range = parseByteRange(requestRange, fileStat.size);
  const contentType = mediaContentType(absolutePath);
  const baseHeaders = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Content-Type': contentType,
    'Last-Modified': fileStat.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  });
  if (contentType.startsWith('text/html') || contentType.startsWith('application/xhtml+xml')) {
    baseHeaders.set('Content-Security-Policy', "sandbox; default-src 'none'");
  }

  if (range === 'invalid') {
    baseHeaders.set('Content-Range', `bytes */${fileStat.size}`);
    baseHeaders.set('Content-Length', '0');
    return new Response(null, { status: 416, headers: baseHeaders });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, fileStat.size - 1);
  const length = fileStat.size === 0 ? 0 : end - start + 1;
  baseHeaders.set('Content-Length', String(length));
  if (range) baseHeaders.set('Content-Range', `bytes ${start}-${end}/${fileStat.size}`);

  if (fileStat.size === 0) {
    return new Response(null, { status: range ? 206 : 200, headers: baseHeaders });
  }

  const nodeStream = createReadStream(absolutePath, { start, end });
  const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  return new Response(body, { status: range ? 206 : 200, headers: baseHeaders });
}

/** Serves navigable project assets and rewrites HTML so links stay in preview. */
export async function createProjectPreviewResponse(
  absolutePath: string,
  baseHref: string,
  previewRootHref: string,
  requestRange?: string,
): Promise<Response> {
  const contentType = mediaContentType(absolutePath);
  const isHtml = contentType.startsWith('text/html') || contentType.startsWith('application/xhtml+xml');
  const isCss = contentType.startsWith('text/css');
  if (!isHtml && !isCss) {
    return createMediaFileResponse(absolutePath, requestRange);
  }

  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
  const source = await readFile(absolutePath, 'utf8');
  const body = isHtml
    ? prepareProjectPreviewHtml(source, baseHref, previewRootHref)
    : prepareProjectPreviewCss(source, previewRootHref);
  return new Response(body, {
    headers: {
      'Cache-Control': 'no-cache',
      ...(isHtml ? { 'Content-Security-Policy': "connect-src 'none'; object-src 'none'" } : {}),
      'Content-Type': contentType,
      'Last-Modified': fileStat.mtime.toUTCString(),
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
