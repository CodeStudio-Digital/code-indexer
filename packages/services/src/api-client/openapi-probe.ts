/**
 * OpenAPI spec discovery. The conventional candidate paths are shared with
 * the company Scalar route; here we read from the HOST filesystem (project
 * root_path) since the in-app Postman targets local projects, not sandbox
 * containers.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import { readProjectFile } from './read-project-file.js';

export const OPENAPI_CANDIDATES: ReadonlyArray<string> = [
  'openapi.yaml', 'openapi.yml', 'openapi.json',
  'docs/openapi.yaml', 'docs/openapi.yml', 'docs/openapi.json',
  'api/openapi.yaml', 'api/openapi.yml', 'api/openapi.json',
  'swagger.yaml', 'swagger.yml', 'swagger.json',
];

export interface ProbedSpec {
  relPath: string;
  raw: string;
  format: 'yaml' | 'json';
}

/**
 * Find the first readable OpenAPI/Swagger file under `rootPath`. When
 * `explicit` is given, only that path is tried. Returns null when none read.
 */
export async function probeOpenApiOnHost(rootPath: string, explicit?: string, signal?: AbortSignal): Promise<ProbedSpec | null> {
  const rootAbs = resolve(rootPath);
  const candidates = explicit ? [explicit] : OPENAPI_CANDIDATES;
  for (const rel of candidates) {
    signal?.throwIfAborted();
    // Containment: an explicit specPath is attacker/agent-influenceable (HTTP
    // body + the api_import_openapi tool), so never read outside the project root.
    // `isWithinRoot` rejects `..` escapes and absolute / cross-drive (UNC) paths,
    // closing the arbitrary-file-read oracle (a parse failure echoes file content).
    const abs = resolve(rootAbs, rel);
    if (!isWithinRoot(rootAbs, abs)) continue;
    try {
      const raw = (await readProjectFile(abs, { fileRoot: rootAbs, signal }, 8 * 1024 * 1024)).toString('utf8');
      return { relPath: rel, raw, format: rel.endsWith('.json') ? 'json' : 'yaml' };
    } catch (cause) {
      signal?.throwIfAborted();
      if (cause instanceof Error && /byte limit|changed during read/.test(cause.message)) throw cause;
      // not present / unreadable — try the next candidate
    }
  }
  return null;
}

function isWithinRoot(rootAbs: string, abs: string): boolean {
  const rel = relative(rootAbs, abs);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
