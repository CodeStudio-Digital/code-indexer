import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCAN_ROOTS = [
  join(ROOT, 'packages', 'code-agent', 'src', 'tools'),
  join(ROOT, 'packages', 'company', 'src', 'tools'),
];
const STRICT_JSON_ALLOWLIST = new Set([
  'packages/code-agent/src/tools/api-client/query.ts',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('model-facing native output contract', () => {
  it('does not add JSON.stringify results directly to model context', () => {
    const offenders = SCAN_ROOTS.flatMap(sourceFiles).flatMap((path) => {
      const normalized = relative(ROOT, path).replaceAll('\\', '/');
      if (STRICT_JSON_ALLOWLIST.has(normalized)) return [];
      const source = readFileSync(path, 'utf8');
      return /\b(?:ok|err)\s*\(\s*JSON\.stringify\s*\(/m.test(source) ? [normalized] : [];
    });

    expect(offenders, 'Use structuredResult/okStructured/errStructured; allowlist only strict JSON contracts.').toEqual([]);
  });
});
