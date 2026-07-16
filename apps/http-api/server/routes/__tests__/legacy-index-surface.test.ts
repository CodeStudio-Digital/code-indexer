import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = process.cwd();
const source = (path: string): string => readFileSync(resolve(repo, path), 'utf8');

describe('retired LLM index surfaces', () => {
  it('does not mount legacy diff or cost routes', () => {
    const server = source('apps/http-api/server.ts');
    expect(server).not.toContain('mountDiffRoutes');
    expect(server).not.toContain('mountCostsRoutes');
    expect(existsSync(resolve(repo, 'apps/http-api/server/routes/diff.ts'))).toBe(false);
    expect(existsSync(resolve(repo, 'apps/http-api/server/routes/costs.ts'))).toBe(false);
  });

  it('does not expose concepts or artificial architecture endpoints', () => {
    expect(source('apps/http-api/server/routes/files.ts')).not.toContain('/concepts');
    expect(source('apps/http-api/server/routes/graph.ts')).not.toContain('/architecture');
    expect(source('packages/api-bus/src/files.ts')).not.toContain('listConcepts');
    expect(source('packages/api-bus/src/files.ts')).not.toContain('conceptFiles');
  });

  it('keeps the search result UI independent from legacy summaries', () => {
    const panel = source('apps/dashboard/features/search/SearchPanel.tsx');
    const preview = source('apps/dashboard/features/search/search-result-preview.ts');
    expect(panel).not.toMatch(/data\.(?:summary|concepts|layer|complexity)/);
    expect(preview).not.toMatch(/data\.(?:summary|concepts|layer|complexity)/);
  });
});
