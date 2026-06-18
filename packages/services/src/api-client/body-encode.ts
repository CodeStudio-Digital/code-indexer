/**
 * body-encode — turn a stored request body (any of the 7 kinds) into the actual
 * HTTP payload + a default Content-Type. Pure except for reading files referenced
 * by form-data/binary rows. Shared by the send route, the regression runner and
 * the agent run tool so every path serializes a body identically.
 *
 * Templates (`{{var}}`) are resolved here for text-bearing kinds. Legacy
 * `body_kind === 'form'` (pre-mig-156) is treated as 'urlencoded'.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { normalizeKvList, resolveTemplate, type KvRow } from './request-builder.js';

export interface BodyLike {
  body_kind: string;
  body_json?: string | null;
  body_raw_lang?: string | null;
  body_form_json?: string | null;
  body_urlencoded_json?: string | null;
  body_graphql_json?: string | null;
  body_binary_path?: string | null;
}

export interface EncodedBody {
  body?: string | Buffer;
  /** Default content-type; the caller skips it if the user set one explicitly. */
  contentType?: string;
}

const RAW_MIME: Record<string, string> = {
  text: 'text/plain',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  javascript: 'application/javascript',
};

function rows(json: string | null | undefined): KvRow[] {
  return normalizeKvList(json).filter((r) => r.enabled && r.key);
}

export async function encodeBody(
  req: BodyLike,
  vars: Record<string, string>,
  opts?: { boundary?: string },
): Promise<EncodedBody> {
  const kind = req.body_kind === 'form' ? 'urlencoded' : req.body_kind;
  switch (kind) {
    case 'none':
      return {};

    case 'json':
      return { body: resolveTemplate(req.body_json ?? '', vars), contentType: 'application/json' };

    case 'raw':
      return {
        body: resolveTemplate(req.body_json ?? '', vars),
        contentType: RAW_MIME[req.body_raw_lang ?? 'text'] ?? 'text/plain',
      };

    case 'urlencoded': {
      const p = new URLSearchParams();
      for (const r of rows(req.body_urlencoded_json)) {
        p.append(resolveTemplate(r.key, vars), resolveTemplate(r.value, vars));
      }
      return { body: p.toString(), contentType: 'application/x-www-form-urlencoded' };
    }

    case 'graphql': {
      let query = '';
      let variables: unknown = undefined;
      try {
        const g = JSON.parse(req.body_graphql_json ?? '{}') as { query?: string; variables?: string };
        query = resolveTemplate(g.query ?? '', vars);
        const rawVars = resolveTemplate(g.variables ?? '', vars).trim();
        variables = rawVars ? JSON.parse(rawVars) : undefined;
      } catch { /* leave query/variables as-is */ }
      return { body: JSON.stringify({ query, variables }), contentType: 'application/json' };
    }

    case 'form-data':
      return encodeMultipart(rows(req.body_form_json), vars, opts?.boundary ?? defaultBoundary());

    case 'binary': {
      const path = req.body_binary_path;
      if (!path) return {};
      // Async read so a large cold file upload never blocks the http-api event loop.
      return { body: await readFile(path), contentType: 'application/octet-stream' };
    }

    default:
      return {};
  }
}

function defaultBoundary(): string {
  return `----McpApiClient${Math.random().toString(36).slice(2)}`;
}

async function encodeMultipart(parts: KvRow[], vars: Record<string, string>, boundary: string): Promise<EncodedBody> {
  const chunks: Buffer[] = [];
  const CRLF = '\r\n';
  for (const p of parts) {
    const name = resolveTemplate(p.key, vars);
    if (p.src) {
      const file = await readFile(p.src);
      chunks.push(Buffer.from(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"; filename="${basename(p.src)}"${CRLF}`
        + `Content-Type: application/octet-stream${CRLF}${CRLF}`,
      ));
      chunks.push(file, Buffer.from(CRLF));
    } else {
      const value = resolveTemplate(p.value, vars);
      chunks.push(Buffer.from(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`,
      ));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
