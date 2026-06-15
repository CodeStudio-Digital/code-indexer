/**
 * OpenAPI spec discovery. The conventional candidate paths are shared with
 * the company Scalar route; here we read from the HOST filesystem (project
 * root_path) since the in-app Postman targets local projects, not sandbox
 * containers.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
export async function probeOpenApiOnHost(rootPath: string, explicit?: string): Promise<ProbedSpec | null> {
  const candidates = explicit ? [explicit] : OPENAPI_CANDIDATES;
  for (const rel of candidates) {
    try {
      const raw = await readFile(join(rootPath, rel), 'utf8');
      return { relPath: rel, raw, format: rel.endsWith('.json') ? 'json' : 'yaml' };
    } catch {
      // not present / unreadable — try the next candidate
    }
  }
  return null;
}
