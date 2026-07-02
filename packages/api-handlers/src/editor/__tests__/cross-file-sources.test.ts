import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lsp/server-backend.js', () => ({
  ensureLspManager: vi.fn(),
  serverCompletion: vi.fn(),
  serverDefinition: vi.fn(),
}));

import { ensureLspManager, serverDefinition } from '../../lsp/server-backend.js';
import { openDoc, changeDoc, closeDoc } from '../../lsp/document-store.js';
import {
  handleEvent, ensureTracking, recentEdits, tabRecency, __resetEditTrackerForTests,
} from '../completion/snippets/edit-tracker.js';
import { tokenizeLine, tokenSet, bestWindow } from '../completion/snippets/jaccard.js';
import { openTabSnippets } from '../completion/snippets/source-open-tabs.js';
import { recentEditSnippets } from '../completion/snippets/source-recent-edits.js';
import { lspDefSnippets, nearCursorIdents } from '../completion/snippets/source-lsp-defs.js';
import type { EngineInput } from '../completion/snippets/types.js';

const mockEnsure = vi.mocked(ensureLspManager);
const mockDefinition = vi.mocked(serverDefinition);

function fakeDb(over: Partial<Record<string, (...a: unknown[]) => unknown>> = {}) {
  return {
    getProject: () => ({ root_path: 'D:/repo' }),
    getSymbolsByFile: () => [],
    ...over,
  } as never;
}

function engineInput(over: Partial<EngineInput> = {}): EngineInput {
  return {
    db: fakeDb(),
    projectId: 7,
    file: 'src/a.php',
    language: 'php',
    windows: { prefix: 'function syncAccounts($data) {\n  $results = [];\n  ', suffix: '\n}' },
    position: { line: 3, col: 3 },
    budgetTokens: 2500,
    sourceTimeoutMs: 100,
    deadlineMs: 150,
    cacheTtlMs: 10_000,
    lspMemberRaceMs: 250,
    toggles: { recentEdits: true, openTabs: true, lspDefs: true },
    jaccardMinScore: 0.05,
    maxTabFiles: 10,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetEditTrackerForTests();
  mockEnsure.mockReturnValue({ status: () => ({ state: 'idle' }) } as never);
});

afterEach(() => {
  for (const f of ['src/a.php', 'src/b.php', 'src/c.php']) closeDoc(7, f);
});

describe('edit-tracker', () => {
  const doc = (content: string, version = 2) => ({ content, version, languageId: 'php' });
  const change = (line: number, text = 'x') => ({
    range: { start: { line, column: 1 }, end: { line, column: 1 } },
    rangeOffset: 0, rangeLength: 0, text,
  });

  it('records change spans and coalesces nearby edits', () => {
    const content = 'l1\nl2\nl3\nl4\nl5';
    handleEvent({ projectId: 7, file: 'src/b.php', doc: doc(content), kind: 'change', changes: [change(2)] });
    handleEvent({ projectId: 7, file: 'src/b.php', doc: doc(content, 3), kind: 'change', changes: [change(3)] });
    const spans = recentEdits(7, 'other.php');
    expect(spans).toHaveLength(1); // lines 2 and 3 coalesced (±2)
    expect(spans[0]!.startLine).toBe(2);
    expect(spans[0]!.endLine).toBe(3);
  });

  it('evicts beyond the ring cap and drops entries on close', () => {
    for (let i = 0; i < 12; i++) {
      handleEvent({
        projectId: 7, file: 'src/b.php', doc: doc('irrelevant', i + 2),
        kind: 'change', changes: [change(i * 10 + 1)],
      });
    }
    expect(recentEdits(7, 'other.php').length).toBeLessThanOrEqual(8);
    handleEvent({ projectId: 7, file: 'src/b.php', doc: doc('', 99), kind: 'close' });
    expect(recentEdits(7, 'other.php')).toHaveLength(0);
  });

  it('excludes same-file spans inside the prompt window, keeps far ones', () => {
    handleEvent({ projectId: 7, file: 'src/b.php', doc: doc('c'), kind: 'change', changes: [change(2)] });
    handleEvent({ projectId: 7, file: 'src/b.php', doc: doc('c', 3), kind: 'change', changes: [change(200)] });
    const spans = recentEdits(7, 'src/b.php', [150, 210]);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.startLine).toBe(2);
  });

  it('tracks tab recency on open/change', () => {
    handleEvent({ projectId: 7, file: 'src/b.php', doc: doc('x', 1), kind: 'open' });
    handleEvent({ projectId: 7, file: 'src/c.php', doc: doc('x', 1), kind: 'open' });
    const rec = tabRecency(7);
    expect([...rec.keys()]).toEqual(['src/b.php', 'src/c.php']);
    expect(() => ensureTracking()).not.toThrow(); // idempotent
    ensureTracking();
  });
});

describe('jaccard', () => {
  it('tokenizes with min length and case folding', () => {
    expect(tokenizeLine('$totalServices = LoyaltyServiceModel::where($id);'))
      .toEqual(['totalservices', 'loyaltyservicemodel', 'where']);
  });

  it('incremental bestWindow equals brute force on random-ish input', () => {
    const lines = Array.from({ length: 150 }, (_, i) => `token${i % 37} alpha${(i * 7) % 11} beta${i % 5}`);
    const refSet = tokenSet(['token3 alpha7', 'beta2 token10']);
    const win = 20;
    const incremental = bestWindow(lines, refSet, win)!;
    // brute force
    let best = { score: -1, startLine: 0 };
    for (let s = 0; s + win <= lines.length; s++) {
      const set = tokenSet(lines.slice(s, s + win));
      let inter = 0;
      for (const t of set) if (refSet.has(t)) inter++;
      const score = inter / (refSet.size + set.size - inter);
      if (score > best.score) best = { score, startLine: s + 1 };
    }
    expect(incremental.startLine).toBe(best.startLine);
    expect(incremental.score).toBeCloseTo(best.score, 10);
  });

  it('handles files shorter than the window and zero-overlap', () => {
    expect(bestWindow(['foo bar'], tokenSet(['foo something']), 60)!.score).toBeGreaterThan(0);
    expect(bestWindow(['aaa bbb'], tokenSet(['zzz yyy']), 60)).toBeNull();
  });
});

describe('source-open-tabs', () => {
  it('finds the best window in another open tab of the same language', () => {
    const similar = [
      'function syncAccounts($data) {',
      '  $results = [];',
      '  foreach ($data as $account) {',
      '    $results[] = $this->syncOne($account);',
      '  }',
      '}',
    ].join('\n');
    openDoc(7, 'src/b.php', 'php', 1, `<?php\n// filler\n${similar}\n// tail`);
    openDoc(7, 'src/c.php', 'typescript', 1, similar); // wrong language — excluded
    handleEvent({ projectId: 7, file: 'src/b.php', doc: { content: '', version: 1, languageId: 'php' }, kind: 'open' });

    const snips = openTabSnippets(engineInput());
    expect(snips).toHaveLength(1);
    expect(snips[0]!.filePath).toBe('src/b.php');
    expect(snips[0]!.content).toContain('syncAccounts');
  });

  it('excludes the current file and respects the min score', () => {
    openDoc(7, 'src/a.php', 'php', 1, 'function syncAccounts($data) {}');
    openDoc(7, 'src/b.php', 'php', 1, 'completely unrelated words nothing shared zebra');
    const snips = openTabSnippets(engineInput({ jaccardMinScore: 0.5 }));
    expect(snips).toHaveLength(0);
  });
});

describe('source-recent-edits', () => {
  it('excerpts the CURRENT buffer around recorded spans from other files', () => {
    const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    openDoc(7, 'src/b.php', 'php', 1, content);
    handleEvent({
      projectId: 7, file: 'src/b.php',
      doc: { content, version: 2, languageId: 'php' },
      kind: 'change',
      changes: [{ range: { start: { line: 15, column: 1 }, end: { line: 15, column: 1 } }, rangeOffset: 0, rangeLength: 0, text: 'x' }],
    });
    const snips = recentEditSnippets(engineInput());
    expect(snips).toHaveLength(1);
    expect(snips[0]!.filePath).toBe('src/b.php');
    expect(snips[0]!.content).toContain('line 15');
    expect(snips[0]!.content).toContain('line 12'); // ±3 pad
  });
});

describe('source-lsp-defs', () => {
  it('extracts near-cursor identifiers, filtering keywords and short locals', () => {
    const idents = nearCursorIdents('function handle(SyncService $svc) {\n  $svc->process(', 10);
    const names = idents.map((i) => i.name);
    expect(names).toContain('SyncService');
    expect(names).not.toContain('function');
    expect(names).not.toContain('svc');
  });

  it('returns [] when no server is warm; excerpts the def when warm', async () => {
    expect(await lspDefSnippets(engineInput())).toEqual([]);
    expect(mockDefinition).not.toHaveBeenCalled();

    mockEnsure.mockReturnValue({ status: () => ({ state: 'ready' }) } as never);
    mockDefinition.mockResolvedValue([
      { file: 'D:/repo/src/SyncService.php', range: { start: { line: 3, column: 1 }, end: { line: 3, column: 10 } } },
    ] as never);
    openDoc(7, 'src/SyncService.php', 'php', 1, '<?php\n\nclass SyncService {\n  public function process($x) {}\n}\n');
    try {
      const snips = await lspDefSnippets(engineInput({
        db: fakeDb({
          getSymbolsByFile: () => [{
            id: 1, name: 'SyncService', kind: 'class', line: 3, end_line: 5, file_path: 'src/SyncService.php',
          }],
        }),
        windows: { prefix: 'function handle(SyncService $svc) {\n  ', suffix: '' },
      }));
      expect(snips).toHaveLength(1);
      expect(snips[0]!.filePath).toBe('src/SyncService.php');
      expect(snips[0]!.content).toContain('class SyncService');
    } finally {
      closeDoc(7, 'src/SyncService.php');
    }
  });
});

describe('document-store integration sanity', () => {
  it('changeDoc events reach the tracker through the real store', () => {
    ensureTracking();
    openDoc(7, 'src/b.php', 'php', 1, 'aaa\nbbb\nccc');
    changeDoc(7, 'src/b.php', 2, [{ range: { start: { line: 2, column: 1 }, end: { line: 2, column: 1 } }, rangeOffset: 4, rangeLength: 0, text: 'X' }]);
    const spans = recentEdits(7, 'zzz.php');
    expect(spans.some((s) => s.file === 'src/b.php' && s.startLine === 2)).toBe(true);
  });
});
