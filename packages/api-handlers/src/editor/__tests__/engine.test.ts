import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DBSymbol } from '@mcp/shared/types.js';

vi.mock('../../lsp/server-backend.js', () => ({
  ensureLspManager: vi.fn(),
  serverCompletion: vi.fn(),
}));

import { ensureLspManager } from '../../lsp/server-backend.js';
import { openDoc, closeDoc } from '../../lsp/document-store.js';
import {
  assembleContext, packByPriority, renderSnippetSections, __clearStableCacheForTests,
} from '../completion/snippets/engine.js';
import { approxTokens, type ContextSnippet, type EngineInput } from '../completion/snippets/types.js';

const mockEnsure = vi.mocked(ensureLspManager);

let symId = 0;
function sym(p: Partial<DBSymbol>): DBSymbol {
  return {
    id: ++symId, project_id: 1, file_id: 1, file_path: 'x.php', name: 'x', kind: 'method',
    signature: '', parent: null, namespace: null, modifiers: '[]', return_type: null, parameters: null,
    line: 1, col: 1, end_line: 1, exported: 1, comment: null, tags: '[]',
    created_at: '', stable_id: null, ...p,
  } as DBSymbol;
}

function fakeDb(over: Partial<Record<string, (...a: unknown[]) => unknown>> = {}) {
  const db: Record<string, (...a: unknown[]) => unknown> = {
    getProject: () => ({ root_path: '/repo' }),
    getFile: () => ({ id: 1 }),
    getDependencies: () => [],
    getSymbolsByFile: () => [],
    getClassMembers: () => [],
    getClassMembersDeep: (_p: unknown, name: unknown) => ({ members: db.getClassMembers!(name, _p), ancestry: [] }),
    findSymbolsByName: () => [],
    getSymbolHierarchy: () => ({ extends_chain: [] }),
    ...over,
  };
  return db as never;
}

function engineInput(over: Partial<EngineInput> = {}): EngineInput {
  return {
    db: fakeDb(),
    projectId: 1,
    file: 'svc.php',
    language: 'php',
    windows: { prefix: 'class Svc {\n  function run() {\n    ', suffix: '\n}' },
    position: { line: 12, col: 5 },
    budgetTokens: 2500,
    sourceTimeoutMs: 100,
    deadlineMs: 150,
    cacheTtlMs: 10_000,
    lspMemberRaceMs: 250,
    toggles: { recentEdits: true, openTabs: true, lspDefs: true },
    jaccardMinScore: 0.1,
    maxTabFiles: 10,
    ...over,
  };
}

function snip(kind: ContextSnippet['kind'], content: string, score = 1): ContextSnippet {
  return { kind, filePath: 'f', content, score, tokens: approxTokens(content), volatile: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  __clearStableCacheForTests();
  mockEnsure.mockReturnValue({ status: () => ({ state: 'idle' }) } as never);
});

describe('packByPriority', () => {
  it('packs markers and members before tabs/imports under a tight budget', () => {
    const big = 'x'.repeat(700); // 200 tokens
    const snips = [
      snip('imports', big),
      snip('open-tab', big),
      snip('members', big),
      snip('marker', 'Path: a.php'),
    ];
    const packed = packByPriority(snips, 300);
    const kinds = packed.map((s) => s.kind);
    expect(kinds).toContain('marker');
    expect(kinds).toContain('members');
    expect(kinds).not.toContain('imports');
  });

  it('lets a smaller lower-priority snippet fill leftover budget', () => {
    const packed = packByPriority(
      [snip('members', 'x'.repeat(700)), snip('imports', 'tiny')],
      220,
    );
    expect(packed.map((s) => s.kind)).toEqual(['members', 'imports']);
  });

  it('orders by score within a kind', () => {
    const packed = packByPriority(
      [snip('open-tab', 'low', 0.2), snip('open-tab', 'high', 0.9)],
      1000,
    );
    expect(packed[0]!.content).toBe('high');
  });
});

describe('assembleContext', () => {
  it('assembles markers + siblings + scope + members from the index', async () => {
    const db = fakeDb({
      getSymbolsByFile: () => [
        sym({ name: 'Svc', kind: 'class', line: 1, end_line: 50 }),
        sym({ name: 'run', kind: 'method', line: 10, end_line: 20, return_type: 'void' }),
      ],
      getClassMembers: (name: unknown) =>
        name === 'Helper' ? [sym({ name: 'fmt', kind: 'method' })]
        : name === 'Svc' ? [sym({ name: 'run', kind: 'method' })] : [],
    });
    const ctx = await assembleContext(engineInput({
      db,
      windows: { prefix: 'class Svc {\n  function run() {\n    Helper::', suffix: '' },
    }));
    expect(ctx.memberTriggerHit).toBe(true);
    expect(ctx.memberSource).toBe('index');
    const stableText = renderSnippetSections(ctx.stable);
    const volatileText = renderSnippetSections(ctx.volatile);
    expect(stableText).toContain('Path: svc.php');
    expect(stableText).toContain('### Current class & file');
    expect(volatileText).toContain('### Members of Helper (static)');
    expect(volatileText).toContain('### Scope');
    expect(ctx.totalTokens).toBeGreaterThan(0);
  });

  it('serves the stable block from cache on the second call in the same region', async () => {
    const getDeps = vi.fn(() => []);
    const db = fakeDb({
      getSymbolsByFile: () => [sym({ name: 'Svc', kind: 'class', line: 1, end_line: 50 })],
      getDependencies: getDeps,
    });
    const first = await assembleContext(engineInput({ db }));
    expect(first.stableCacheHit).toBe(false);
    const second = await assembleContext(engineInput({ db }));
    expect(second.stableCacheHit).toBe(true);
    expect(getDeps).toHaveBeenCalledTimes(1); // imports source skipped on hit
    expect(second.regionKey).toBe(first.regionKey);
  });

  it('misses the cache when the cursor moves to a different region', async () => {
    const db = fakeDb({
      getSymbolsByFile: () => [
        sym({ name: 'A', kind: 'class', line: 1, end_line: 20 }),
        sym({ name: 'B', kind: 'class', line: 30, end_line: 60 }),
      ],
    });
    const inA = await assembleContext(engineInput({ db, position: { line: 10, col: 1 } }));
    const inB = await assembleContext(engineInput({ db, position: { line: 40, col: 1 } }));
    expect(inB.regionKey).not.toBe(inA.regionKey);
    expect(inB.stableCacheHit).toBe(false);
  });

  it('expires the stable cache by TTL', async () => {
    vi.useFakeTimers();
    try {
      const db = fakeDb({ getSymbolsByFile: () => [sym({ name: 'Svc', kind: 'class', line: 1, end_line: 50 })] });
      await assembleContext(engineInput({ db, cacheTtlMs: 1000 }));
      vi.advanceTimersByTime(1500);
      const later = await assembleContext(engineInput({ db, cacheTtlMs: 1000 }));
      expect(later.stableCacheHit).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rebuilds on a doc-version jump (big paste) inside the TTL', async () => {
    openDoc(1, 'svc.php', 'php', 1, 'class Svc {}');
    try {
      const db = fakeDb({ getSymbolsByFile: () => [sym({ name: 'Svc', kind: 'class', line: 1, end_line: 50 })] });
      await assembleContext(engineInput({ db }));
      closeDoc(1, 'svc.php');
      openDoc(1, 'svc.php', 'php', 99, 'class Svc {}'); // version leaped ≥50
      const after = await assembleContext(engineInput({ db }));
      expect(after.stableCacheHit).toBe(false);
    } finally {
      closeDoc(1, 'svc.php');
    }
  });

  it('resolves typed $var-> via the live buffer (memberSource index, inferSource local)', async () => {
    openDoc(1, 'svc.php', 'php', 1, '<?php\n$svc = new SyncService();\n$svc->\n');
    try {
      const db = fakeDb({
        getClassMembers: (name: unknown) =>
          name === 'SyncService' ? [sym({ name: 'handle', kind: 'method' })] : [],
      });
      const ctx = await assembleContext(engineInput({
        db,
        windows: { prefix: '<?php\n$svc = new SyncService();\n$svc->', suffix: '\n' },
        position: { line: 3, col: 7 },
      }));
      expect(ctx.memberSource).toBe('index');
      expect(ctx.inferSource).toBe('local');
      expect(renderSnippetSections(ctx.volatile)).toContain('handle');
    } finally {
      closeDoc(1, 'svc.php');
    }
  });

  it('a hanging source times out without blocking the request', async () => {
    const db = fakeDb({
      getSymbolsByFile: () => [sym({ name: 'Svc', kind: 'class', line: 1, end_line: 50 })],
      getDependencies: () => new Promise(() => { /* never resolves */ }) as never,
    });
    const started = performance.now();
    const ctx = await assembleContext(engineInput({ db, sourceTimeoutMs: 50, deadlineMs: 80 }));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(renderSnippetSections(ctx.stable)).toContain('Path: svc.php'); // markers survive
  });

  it('a throwing source fail-opens; a throwing engine returns empty context', async () => {
    const db = fakeDb({
      getSymbolsByFile: () => { throw new Error('db down'); },
      getDependencies: () => { throw new Error('db down'); },
    });
    const ctx = await assembleContext(engineInput({ db }));
    expect(ctx.memberSource).toBe('none');
    expect(renderSnippetSections(ctx.stable)).toContain('Path: svc.php');
  });
});
