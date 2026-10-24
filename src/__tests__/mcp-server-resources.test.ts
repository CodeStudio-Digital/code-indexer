import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SemanticStore } from '@mcp/store/semantic-store.js';
import type { ToolContext } from '../../apps/mcp-server/context.js';
import {
  allResources,
  collectListedResources,
  readResource,
  DEFAULT_RESOURCE_SCOPE,
} from '../../apps/mcp-server/resources/index.js';

/**
 * MCP server resources — projects.overview + projects.repo_map +
 * snapshots.snapshot. These tests exercise the resource registry directly
 * (the same surface the stdio/HTTP transports drive). They build a
 * minimal ToolContext containing only the `db` that the three resources
 * actually use — none of them touch the other services on the context, so
 * casting is honest enough for unit coverage.
 */

function makeProjectFile(path: string) {
  return {
    language: 'ts',
    size: 100,
    lineCount: 50,
    contentHash: `h:${path}`,
    summary: `summary of ${path}`,
    concepts: ['retrieval', 'indexing'],
    dependencies: [],
    internalDeps: [],
    externalDeps: [],
    notes: [],
    complexity: 'low',
    layer: 'core',
    isEntryPoint: path.endsWith('index.ts'),
    isTest: false,
    isGenerated: false,
    path,
  };
}

describe('mcp-server resources', () => {
  let dir: string;
  let db: CodeIndexDB;
  let projectId: number;
  let ctx: ToolContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-srv-res-'));
    db = new CodeIndexDB(join(dir, 'idx.db'));
    const project = db.createProject('demo-proj', dir);
    projectId = project.id;

    const fileId = db.upsertFile(projectId, makeProjectFile('src/index.ts'));
    db.upsertSymbols(projectId, fileId, 'src/index.ts', [
      {
        name: 'startServer',
        kind: 'function',
        signature: 'startServer()',
        parent: null,
        modifiers: ['export'],
        return_type: 'void',
        parameters: '',
        line: 1,
        comment: null,
        tags: [],
      },
    ]);

    const otherFileId = db.upsertFile(projectId, makeProjectFile('src/lib/util.ts'));
    db.upsertSymbols(projectId, otherFileId, 'src/lib/util.ts', [
      {
        name: 'parseFlag',
        kind: 'function',
        signature: 'parseFlag(s: string)',
        parent: null,
        modifiers: ['export'],
        return_type: 'boolean',
        parameters: 's: string',
        line: 1,
        comment: null,
        tags: [],
      },
    ]);

    // Minimal context: only `db` is touched by the three Phase 1 resources.
    // Cast through unknown to acknowledge we're omitting services that
    // none of the resources call.
    ctx = { db, semanticStore: new SemanticStore(db.raw()) } as unknown as ToolContext;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers exactly the three Phase 1 resources', () => {
    const names = allResources.map((r) => r.name).sort();
    expect(names).toEqual(['project_overview', 'repo_map', 'snapshot']);
  });

  it('defaults all resources to mcp:read scope', () => {
    for (const r of allResources) {
      expect(r.scope ?? DEFAULT_RESOURCE_SCOPE).toBe('mcp:read');
    }
  });

  describe('resources/list', () => {
    it('reports backend failure rather than a false empty catalog or missing URI', async () => {
      vi.spyOn(db, 'countFiles').mockImplementationOnce(() => { throw new Error('index unavailable'); });
      await expect(collectListedResources(ctx)).rejects.toThrow('index unavailable');
      vi.spyOn(db, 'getStats').mockImplementationOnce(() => { throw new Error('index unavailable'); });
      await expect(readResource('mcp://project/demo-proj/overview', ctx)).rejects.toThrow('index unavailable');
    });
    it('returns overview + repo-map per indexed project, omits snapshot', async () => {
      const fullFiles = vi.spyOn(db, 'listFiles');
      const listed = await collectListedResources(ctx);
      expect(fullFiles).not.toHaveBeenCalled();
      const uris = listed.map((r) => r.uri).sort();
      expect(uris).toEqual([
        'mcp://project/demo-proj/overview',
        'mcp://project/demo-proj/repo-map',
      ]);
    });

    it('skips projects with zero indexed files', async () => {
      db.createProject('empty-proj', dir);
      const listed = await collectListedResources(ctx);
      const uris = listed.map((r) => r.uri);
      expect(uris).not.toContain('mcp://project/empty-proj/overview');
      expect(uris).not.toContain('mcp://project/empty-proj/repo-map');
    });
  });

  describe('project_overview resource', () => {
    it('returns current structural and semantic coverage without retired enrichment fields', async () => {
      const result = await readResource('mcp://project/demo-proj/overview', ctx);
      expect(result).not.toBeNull();
      expect(result?.resource.name).toBe('project_overview');
      const text = (result!.contents[0] as { type: 'text'; text: string }).text;
      const payload = JSON.parse(text);
      expect(payload.project).toBe('demo-proj');
      expect(payload.file_count).toBe(2);
      expect(payload).not.toHaveProperty('top_concepts');
      expect(payload.key_files).toContain('src/index.ts');
      expect(payload.structural.state).toBe('ready');
      expect(payload.semantic).toMatchObject({ coverage_pct: expect.any(Number), pending_delta_items: 0 });
    });

    it('returns null for unknown project', async () => {
      const result = await readResource('mcp://project/does-not-exist/overview', ctx);
      expect(result).toBeNull();
    });
  });

  describe('repo_map resource', () => {
    it('returns a markdown structural map listing top-level symbols', async () => {
      const result = await readResource('mcp://project/demo-proj/repo-map', ctx);
      expect(result).not.toBeNull();
      expect(result?.resource.name).toBe('repo_map');
      const text = (result!.contents[0] as { type: 'text'; text: string }).text;
      expect(text).toContain('Repository Map');
      // The builder groups by directory: heading is `## src/` followed by `index.ts`.
      expect(text).toContain('src/');
      expect(text).toContain('index.ts');
      expect(text).toContain('startServer');
    });
  });

  describe('snapshot resource', () => {
    it('is template-only — does not appear in resources/list', async () => {
      const listed = await collectListedResources(ctx);
      expect(listed.some((r) => r.uri.startsWith('mcp://snapshot/'))).toBe(false);
    });

    it('reads a snapshot by id and includes referenced files', async () => {
      const snap = db.createSnapshot(projectId, {
        title: 'Cache eviction',
        category: 'architecture',
        content: 'LRU with 5min TTL.',
        tags: ['perf'],
        createdBy: 'tester',
      });
      db.setSnapshotFiles(snap.id, projectId, ['src/index.ts']);

      const result = await readResource(`mcp://snapshot/demo-proj/${snap.id}`, ctx);
      expect(result).not.toBeNull();
      expect(result?.resource.name).toBe('snapshot');
      const payload = JSON.parse((result!.contents[0] as { type: 'text'; text: string }).text);
      expect(payload).toMatchObject({
        id: snap.id,
        project: 'demo-proj',
        title: 'Cache eviction',
        category: 'architecture',
        tags: ['perf'],
        referenced_files: ['src/index.ts'],
        created_by: 'tester',
      });
    });

    it('refuses to read a snapshot from a different project (id leak)', async () => {
      const other = db.createProject('other-proj', dir);
      const snap = db.createSnapshot(other.id, {
        title: 'Other thing',
        category: 'note',
        content: 'unrelated',
        tags: [],
        createdBy: 'tester',
      });
      // Try to read this snapshot under the wrong project name.
      const result = await readResource(`mcp://snapshot/demo-proj/${snap.id}`, ctx);
      expect(result).toBeNull();
    });

    it('returns null for malformed snapshot URIs', async () => {
      expect(await readResource('mcp://snapshot/demo-proj/abc', ctx)).toBeNull();
      expect(await readResource('mcp://snapshot/demo-proj/-5', ctx)).toBeNull();
      expect(await readResource('mcp://snapshot/demo-proj/9999', ctx)).toBeNull();
    });
  });

  describe('URI dispatch', () => {
    it('returns null when no resource matches the URI', async () => {
      const result = await readResource('mcp://project/demo-proj/unknown-endpoint', ctx);
      expect(result).toBeNull();
    });

    it('tolerates URL-encoded project names', async () => {
      const fancy = db.createProject('with space', dir);
      const fileId = db.upsertFile(fancy.id, makeProjectFile('src/x.ts'));
      db.upsertSymbols(fancy.id, fileId, 'src/x.ts', [
        {
          name: 'x',
          kind: 'function',
          signature: 'x()',
          parent: null,
          modifiers: [],
          return_type: null,
          parameters: null,
          line: 1,
          comment: null,
          tags: [],
        },
      ]);

      const result = await readResource(
        `mcp://project/${encodeURIComponent('with space')}/overview`,
        ctx,
      );
      expect(result).not.toBeNull();
    });
  });
});
