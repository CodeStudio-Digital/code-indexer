import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function source(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), 'utf8');
}

describe('Docs research session persistence boundary', () => {
  it('keeps operational research sessions out of SQLite', async () => {
    const [store, bridge, runtime] = await Promise.all([
      source('../session-store/docs-research-sessions-store.ts'),
      source('../bridges/docs-bridge.ts'),
      source('../index.ts'),
    ]);
    const operational = `${store}\n${bridge}\n${runtime}`;
    expect(operational).not.toMatch(
      /better-sqlite3|docs_research_sessions|\.prepare\s*\(|\.exec\s*\(/,
    );
    expect(store).toContain('FsSessionStore');
    expect(store).toContain("kind: 'docs'");
  });

  it('preserves the SQLite-backed project corpus and suggestions catalog', async () => {
    const route = await source(
      '../../../../apps/http-api/server/routes/docs-agent/index.ts',
    );
    expect(route).toContain(
      'new AutoDiscoveryService({ db: deps.db.raw() })',
    );
    expect(route).toContain('deps.docStore.getChunksByIds');
    expect(route).toContain('deps.docStore.listSuggestions');
    expect(route).toContain('suggestions, collections, sources');
  });
});
