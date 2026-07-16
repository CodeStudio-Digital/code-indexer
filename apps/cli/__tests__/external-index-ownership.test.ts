import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('external index ownership contract', () => {
  it('keeps CLI commands away from LocalVectorRouter, sqlite-vec and raw IndexAgent writers', () => {
    const cli = [
      'apps/cli/helpers.ts',
      'apps/cli/commands/index-cmd.ts',
      'apps/cli/commands/watch.ts',
      'apps/cli/commands/search.ts',
      'apps/cli/commands/snapshots.ts',
    ].map(source).join('\n');

    expect(cli).not.toMatch(/from ['"]@mcp\/store\/local-vector-router/);
    expect(cli).not.toMatch(/from ['"][^'"]*sqlite-vec/);
    expect(cli).not.toMatch(/\bnew\s+IndexAgent\s*\(/);
    expect(source('apps/cli/helpers.ts')).not.toContain('SemanticProfileRuntime');
    expect(source('apps/cli/commands/search.ts')).toContain(
      'new HybridSearch(db, null, new NullEmbeddingService())',
    );
  });

  it('keeps MCP mutation tools FTS-only locally and delegates indexing to HTTP', () => {
    const mcp = [
      'apps/mcp-server/context.ts',
      'apps/mcp-server/index.ts',
      'apps/mcp-server/tools/projects.ts',
      'apps/mcp-server/tools/snapshots.ts',
    ].map(source).join('\n');

    expect(mcp).not.toMatch(/from ['"]@mcp\/store\/local-vector-router/);
    expect(mcp).not.toMatch(/from ['"][^'"]*sqlite-vec/);
    expect(mcp).not.toMatch(/\bnew\s+IndexAgent\s*\(/);
    expect(source('apps/mcp-server/tools/projects.ts')).toContain('requestMcpLocalServer');
    expect(source('apps/mcp-server/context.ts')).toContain('createMcpSemanticSearchClient(config)');
    expect(source('apps/mcp-server/context.ts')).toContain(
      'new HybridSearch(db, null, new NullEmbeddingService())',
    );
  });

  it('runs background memory hygiene inside the service pre-write fence', () => {
    const sweeper = source('apps/http-api/sse/memory-sweeper.ts');
    expect(sweeper).toContain("runScopeMutation('project'");
    expect(sweeper).toContain("runScopeMutation(\n          'user'");
    expect(sweeper).not.toContain('noteScopeMutation(');
  });
});
