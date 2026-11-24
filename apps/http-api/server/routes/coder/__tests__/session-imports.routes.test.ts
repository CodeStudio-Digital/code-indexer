import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { HttpRouter } from '@mcp/shared/http/router.js';
import {
  discoverExternalSessions, ExternalSessionError, type ExternalSessionCandidate, type ExternalSessionSource, type PersistExternalSessionInput,
} from '@mcp/code-agent/sessions/import/index.js';
import type { ServerDeps } from '../../../deps.js';
import { resolveProjectWorktree } from '../../../worktree-reads.js';
import { mountCoderSessionImportRoutes } from '../session-imports.js';

vi.mock('@mcp/code-agent/sessions/import/index.js', async (original: () => Promise<unknown>) => ({
  ...(await original() as typeof import('@mcp/code-agent/sessions/import/index.js')),
  discoverExternalSessions: vi.fn(),
}));
vi.mock('../../../worktree-reads.js', () => ({ resolveProjectWorktree: vi.fn() }));

const codexFixture = fileURLToPath(new URL(
  '../../../../../../packages/code-agent/src/sessions/import/__fixtures__/codex-rollout.jsonl',
  import.meta.url,
));
const IMPORTED_SESSION_ID = '11111111-1111-4111-8111-111111111111';
const DUPLICATE_SESSION_ID = '22222222-2222-4222-8222-222222222222';

function setup(rootPath = 'D:\\MCP', persist?: (input: PersistExternalSessionInput) => unknown) {
  const imported: PersistExternalSessionInput[] = [];
  const deps = {
    db: { getProject: (id: number) => id === 1 ? { id: 1, root_path: rootPath } : null },
    pipelineProviderResolver: { resolveOrNull: async () => null },
    sessionStore: {
      findImportedSession: () => null,
      importExternalSession: (input: PersistExternalSessionInput) => {
        imported.push(input);
        if (persist) return persist(input);
        return {
          session_id: IMPORTED_SESSION_ID,
          source: input.source,
          external_id: input.reference.external_id,
          fingerprint: input.document.fingerprint, imported_messages: input.document.messages.length,
          warnings: input.document.warnings, used_fallback_summary: true,
        };
      },
    },
  } as unknown as ServerDeps;
  const app = new HttpRouter();
  mountCoderSessionImportRoutes(app, deps);
  return { app, imported };
}

function post(app: HttpRouter, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}

function candidate(source: ExternalSessionSource, id: string, cwd: string | null): ExternalSessionCandidate {
  const reference = { source, external_id: id, source_path: `${id}.jsonl` };
  return { ...reference, title: `Investigate ${id}`, cwd, updated_at: null, source_model: null, size_bytes: 10, reference };
}

describe('coder external session import routes', () => {
  it.each(['claude-code', 'codex'] as const)('filters %s by the current folder before applying the list limit', async (source: ExternalSessionSource) => {
    const { app } = setup();
    vi.mocked(discoverExternalSessions).mockResolvedValueOnce([
      candidate(source, 'different', 'D:\\MCP2'),
      candidate(source, 'unknown', null),
      candidate(source, 'active', 'd:/mcp/'),
    ]);
    const response = await app.request(`/api/coder/session-imports/discover?project_id=1&source=${source}&cwd_match=match&limit=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ source, external_id: 'active', matches_project: true }],
      next_cursor: null,
    });
    expect(discoverExternalSessions).toHaveBeenLastCalledWith(source);
  });

  it('uses the selected worktree for discovery, preview and import', async () => {
    const main = 'D:\\AnotherProject';
    const worktree = 'D:\\MCP';
    const { app, imported } = setup(main);
    const request = { source: 'codex', source_path: codexFixture, project_id: 1, worktree_path: worktree };
    vi.mocked(resolveProjectWorktree).mockResolvedValueOnce(worktree).mockResolvedValueOnce(worktree).mockResolvedValueOnce(worktree);
    vi.mocked(discoverExternalSessions).mockResolvedValueOnce([
      candidate('codex', 'main', main), candidate('codex', 'worktree', worktree),
    ]);

    const list = await app.request(`/api/coder/session-imports/discover?project_id=1&cwd_match=match&worktree_path=${encodeURIComponent(worktree)}`);
    expect(await list.json()).toMatchObject({ items: [{ external_id: 'worktree' }] });
    const preview = await post(app, '/api/coder/session-imports/preview', request);
    expect(await preview.json()).toMatchObject({ matches_project: true });
    const result = await post(app, '/api/coder/session-imports/import', {
      ...request, provider: 'definitely-missing-provider', model: 'missing-model',
    });
    expect(result.status).toBe(201);
    expect(imported[0]).toMatchObject({ worktree_path: worktree });
    expect(resolveProjectWorktree).toHaveBeenLastCalledWith(main, worktree);
  });

  it('detects and previews a manually selected JSONL', async () => {
    const { app } = setup();
    const response = await post(app, '/api/coder/session-imports/preview', {
      source_path: codexFixture, project_id: 1,
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { source: string; matches_project: boolean; stats: { message_count: number } };
    expect(body).toMatchObject({ source: 'codex', matches_project: true });
    expect(body.stats.message_count).toBe(6);
  });

  it('requires explicit confirmation when the source cwd differs', async () => {
    const { app } = setup('D:\\AnotherProject');
    const response = await post(app, '/api/coder/session-imports/import', {
      source: 'codex', source_path: codexFixture, external_id: 'codex-session-1',
      project_id: 1, provider: 'missing-provider', model: 'missing-model', agent: 'build',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'project_mismatch' });
  });

  it('uses the deterministic handoff when no summarizer provider is available', async () => {
    const { app, imported } = setup();
    const response = await post(app, '/api/coder/session-imports/import', {
      source: 'codex', source_path: codexFixture, external_id: 'codex-session-1',
      project_id: 1, provider: 'definitely-missing-provider', model: 'missing-model', agent: 'build',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      session_id: IMPORTED_SESSION_ID,
      used_fallback_summary: true,
    });
    expect(imported).toHaveLength(1);
    expect(imported[0].summary.version).toBe(3);
    expect(imported[0].summary.resume.current_focus).toContain('Implement the API');
    expect(imported[0].diagnostics).toMatchObject({ used_fallback_summary: true });
  });

  it('returns the stable duplicate_import error', async () => {
    const { app } = setup('D:\\MCP', () => {
      throw new ExternalSessionError(
        'duplicate_import',
        'already imported',
        { session_id: DUPLICATE_SESSION_ID },
      );
    });
    const response = await post(app, '/api/coder/session-imports/import', {
      source: 'codex', source_path: codexFixture, external_id: 'codex-session-1',
      project_id: 1, provider: 'missing-provider', model: 'missing-model', agent: 'build',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'duplicate_import',
      details: { session_id: DUPLICATE_SESSION_ID },
    });
  });
});
