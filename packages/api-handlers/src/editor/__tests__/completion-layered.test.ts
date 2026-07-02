import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DBSymbol } from '@mcp/shared/types.js';

// Mock the LSP backend so the index path is deterministic; individual tests
// opt into the warm-LSP path by reconfiguring these mocks.
vi.mock('../../lsp/server-backend.js', () => ({
  ensureLspManager: vi.fn(),
  serverCompletion: vi.fn(),
}));

import { ensureLspManager, serverCompletion } from '../../lsp/server-backend.js';
import { signatureLine, memberLine, clampToBudget } from '../completion/render.js';
import { enclosingScopeLine } from '../completion/scope.js';
import { receiverMembers } from '../completion/members.js';
import { importedCatalogs } from '../completion/imports.js';
import { buildLayeredContext } from '../completion/context.js';

const mockEnsure = vi.mocked(ensureLspManager);
const mockServerCompletion = vi.mocked(serverCompletion);

let symId = 0;
function sym(p: Partial<DBSymbol>): DBSymbol {
  return {
    id: ++symId, project_id: 1, file_id: 1, file_path: 'x.php', name: 'x', kind: 'method',
    signature: '', parent: null, namespace: null, modifiers: '[]', return_type: null, parameters: null,
    line: 1, col: 1, end_line: 1, exported: 1, comment: null, tags: '[]',
    created_at: '', stable_id: null, ...p,
  };
}

/** Minimal CodeIndexDB stub — only the methods the tiers call. */
function fakeDb(over: Partial<Record<string, (...a: unknown[]) => unknown>> = {}) {
  const db: Record<string, (...a: unknown[]) => unknown> = {
    getProject: () => ({ root_path: '/repo' }),
    getFile: () => ({ id: 1 }),
    getDependencies: () => [],
    getSymbolsByFile: () => [],
    getClassMembers: () => [],
    // Default deep walk = flat members (delegates through the final object so
    // per-test getClassMembers overrides keep working).
    getClassMembersDeep: (_p: unknown, name: unknown) => ({ members: db.getClassMembers!(name, _p), ancestry: [] }),
    getExtendsChain: () => [],
    findSymbolsByName: () => [],
    getSymbolHierarchy: () => ({ extends_chain: [], implements_list: [], subclasses: [], implementors: [], symbol: undefined }),
    ...over,
  };
  return db as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsure.mockReturnValue({ status: () => ({ state: 'idle' }) } as never);
  mockServerCompletion.mockResolvedValue(null);
});

describe('render', () => {
  it('signatureLine prefers signature, falls back to kind+name', () => {
    expect(signatureLine(sym({ signature: 'function f(int $a): bool' }))).toBe('function f(int $a): bool');
    expect(signatureLine(sym({ name: 'Foo', kind: 'class', signature: '' }))).toBe('class Foo');
  });
  it('memberLine formats callables and properties', () => {
    expect(memberLine(sym({ name: 'where', kind: 'method', parameters: '(col, op, val)', return_type: 'Builder' })))
      .toBe('where(col, op, val): Builder');
    expect(memberLine(sym({ name: 'rate', kind: 'property', return_type: 'float' }))).toBe('rate: float');
  });
  it('clampToBudget stops before exceeding the cap', () => {
    const r = clampToBudget(['aaa', 'bbb', 'ccc'], 8); // 4+4 = 8 fits two, third would be 12
    expect(r.text).toBe('aaa\nbbb');
    expect(r.chars).toBe(8);
  });
});

describe('enclosingScopeLine', () => {
  const syms = [
    sym({ name: 'LoyaltyReportsService', kind: 'class', line: 1, end_line: 50 }),
    sym({ name: 'getDashboardStats', kind: 'method', line: 10, end_line: 40, return_type: 'array' }),
  ];
  it('names method + class + return type', () => {
    expect(enclosingScopeLine(syms, 20)).toBe('Inside method getDashboardStats() of class LoyaltyReportsService (returns array).');
  });
  it('returns empty at top-level', () => {
    expect(enclosingScopeLine(syms, 100)).toBe('');
  });
});

describe('receiverMembers (index path)', () => {
  it('resolves Class:: to that class members (the screenshot case)', async () => {
    const db = fakeDb({
      getClassMembers: (name: unknown) => name === 'LoyaltyServiceModel'
        ? [sym({ name: 'where', kind: 'method', parameters: '(col)' }), sym({ name: 'count', kind: 'method' })]
        : [],
    });
    const r = await receiverMembers({
      db, projectId: 1, file: 'a.php', language: 'php', position: { line: 30, col: 40 },
      lastPrefixLine: '        $totalServices = LoyaltyServiceModel::', syms: [], budgetChars: 700,
    });
    expect(r.source).toBe('index');
    expect(r.triggered).toBe(true);
    expect(r.text).toContain('where(col)');
    expect(r.text).toContain('count');
    expect(r.label).toBe('LoyaltyServiceModel (static)');
  });

  it('resolves $this-> to the enclosing class + inherited members', async () => {
    const db = fakeDb({
      getClassMembersDeep: (_p: unknown, name: unknown) => name === 'Child'
        ? {
            members: [
              sym({ name: 'own', kind: 'method' }),
              { ...sym({ name: 'inherited', kind: 'method' }), inherited_from: 'Base' },
            ],
            ancestry: ['Base'],
          }
        : { members: [], ancestry: [] },
    });
    const syms = [sym({ name: 'Child', kind: 'class', line: 1, end_line: 99 })];
    const r = await receiverMembers({
      db, projectId: 1, file: 'b.php', language: 'php', position: { line: 10, col: 16 },
      lastPrefixLine: '        $this->', syms, budgetChars: 700,
    });
    expect(r.source).toBe('index');
    expect(r.text).toContain('own');
    expect(r.text).toContain('inherited');
  });

  it('does not trigger inside a string literal', async () => {
    const r = await receiverMembers({
      db: fakeDb(), projectId: 1, file: 'c.php', language: 'php', position: { line: 1, col: 20 },
      lastPrefixLine: '$x = "$this->', syms: [], budgetChars: 700,
    });
    expect(r.triggered).toBe(false);
    expect(r.source).toBe('none');
  });

  it('marks a typed $var-> trigger as unresolved (index cannot type it)', async () => {
    const r = await receiverMembers({
      db: fakeDb(), projectId: 1, file: 'd.php', language: 'php', position: { line: 1, col: 8 },
      lastPrefixLine: '  $user->', syms: [], budgetChars: 700,
    });
    expect(r.triggered).toBe(true);
    expect(r.source).toBe('none');
  });

  it('resolves Python self. via dot detection to the enclosing class', async () => {
    const db = fakeDb({
      getClassMembers: (name: unknown) => name === 'Svc' ? [sym({ name: 'run', kind: 'method' })] : [],
    });
    const syms = [sym({ name: 'Svc', kind: 'class', line: 1, end_line: 99 })];
    const r = await receiverMembers({
      db, projectId: 1, file: 'a.py', language: 'python', position: { line: 5, col: 13 },
      lastPrefixLine: '        self.', syms, budgetChars: 700,
    });
    expect(r.triggered).toBe(true);
    expect(r.text).toContain('run');
  });

  it('does NOT treat PHP "." (string concat) as a member trigger', async () => {
    const r = await receiverMembers({
      db: fakeDb(), projectId: 1, file: 'a.php', language: 'php', position: { line: 1, col: 8 },
      lastPrefixLine: '  $a . $b.', syms: [], budgetChars: 700,
    });
    expect(r.triggered).toBe(false);
    expect(r.source).toBe('none');
  });
});

describe('receiverMembers (warm LSP path)', () => {
  it('uses serverCompletion members when a server is ready', async () => {
    mockEnsure.mockReturnValue({ status: () => ({ state: 'ready' }) } as never);
    mockServerCompletion.mockResolvedValue([
      { label: 'firstWhere', kind: 'method', detail: '(col): Model' },
      { label: 'somekeyword', kind: 'keyword' }, // noise — filtered
    ] as never);
    const r = await receiverMembers({
      db: fakeDb(), projectId: 1, file: 'e.php', language: 'php', position: { line: 5, col: 16 },
      lastPrefixLine: '        $user->first', syms: [], budgetChars: 700,
    });
    expect(r.source).toBe('lsp');
    expect(r.text).toContain('firstWhere (col): Model');
    expect(r.text).not.toContain('somekeyword');
  });
});

describe('importedCatalogs', () => {
  it('renders imported class with a method catalog', () => {
    const db = fakeDb({
      getDependencies: () => [{ id: 1, import_path: 'App\\Models\\LoyaltyServiceModel', dep_type: 'internal', target_file_path: 'app/Models/LoyaltyServiceModel.php' }],
      getSymbolsByFile: (_p: unknown, f: unknown) => f === 'app/Models/LoyaltyServiceModel.php'
        ? [sym({ name: 'LoyaltyServiceModel', kind: 'class', exported: 1, parent: null, signature: 'class LoyaltyServiceModel' })]
        : [],
      getClassMembers: () => [sym({ name: 'where', kind: 'method' }), sym({ name: 'count', kind: 'method' })],
    });
    const r = importedCatalogs(db, 1, 'svc.php', 700);
    expect(r.text).toContain('// app/Models/LoyaltyServiceModel.php');
    expect(r.text).toContain('class LoyaltyServiceModel { where() count() }');
  });

  it('resolves an unresolved PHP use-statement by short name', () => {
    const db = fakeDb({
      getDependencies: () => [{ id: 1, import_path: 'App\\Models\\Partner', dep_type: 'internal', target_file_path: null }],
      findSymbolsByName: (_p: unknown, name: unknown) => name === 'Partner'
        ? [sym({ name: 'Partner', kind: 'class', file_path: 'app/Models/Partner.php', parent: null, signature: 'class Partner' })] : [],
      getClassMembers: () => [sym({ name: 'active', kind: 'method' })],
    });
    const r = importedCatalogs(db, 1, 'svc.php', 700);
    expect(r.text).toContain('// App\\Models\\Partner');
    expect(r.text).toContain('class Partner { active() }');
  });
});

describe('buildLayeredContext orchestrator', () => {
  it('assembles scope + members + siblings within budget', async () => {
    const db = fakeDb({
      getSymbolsByFile: () => [
        sym({ name: 'Svc', kind: 'class', line: 1, end_line: 50 }),
        sym({ name: 'run', kind: 'method', line: 10, end_line: 20, return_type: 'void' }),
      ],
      getClassMembers: (name: unknown) => name === 'Helper'
        ? [sym({ name: 'fmt', kind: 'method' })]
        : name === 'Svc' ? [sym({ name: 'run', kind: 'method' })] : [],
    });
    const ctx = await buildLayeredContext({
      db, projectId: 1, file: 'svc.php', language: 'php',
      windows: { prefix: 'class Svc {\n  function run() {\n    Helper::', suffix: '' },
      position: { line: 12, col: 12 }, budgetChars: 2500,
    });
    expect(ctx.tiersUsed).toContain('Scope');
    expect(ctx.memberTriggerHit).toBe(true);
    expect(ctx.block).toContain('### Scope');
    expect(ctx.block).toContain('Inside method run() of class Svc');
    expect(ctx.block).toContain('### Members of Helper (static)');
    expect(ctx.block).toContain('fmt');
    expect(ctx.chars).toBeLessThanOrEqual(2500);
  });

  it('produces no member tier when there is no trigger', async () => {
    const ctx = await buildLayeredContext({
      db: fakeDb(), projectId: 1, file: 'svc.php', language: 'php',
      windows: { prefix: 'const x = ', suffix: '' }, position: { line: 1, col: 11 }, budgetChars: 2500,
    });
    expect(ctx.memberTriggerHit).toBe(false);
    expect(ctx.memberSource).toBe('none');
    expect(ctx.block).not.toContain('### Members');
  });

  it('imports_only mode skips T0/T1/T2 (A/B baseline)', async () => {
    const db = fakeDb({
      getSymbolsByFile: () => [
        sym({ name: 'Svc', kind: 'class', line: 1, end_line: 50 }),
        sym({ name: 'run', kind: 'method', line: 10, end_line: 20 }),
      ],
      getDependencies: () => [{ id: 1, import_path: 'X', dep_type: 'internal', target_file_path: 'x.php' }],
      getClassMembers: () => [],
    });
    const ctx = await buildLayeredContext({
      db, projectId: 1, file: 'svc.php', language: 'php',
      windows: { prefix: 'class Svc {\n  function run() {\n    Helper::', suffix: '' },
      position: { line: 12, col: 12 }, budgetChars: 2500, mode: 'imports_only',
    });
    expect(ctx.block).not.toContain('### Scope');
    expect(ctx.block).not.toContain('### Members');
    expect(ctx.block).not.toContain('### Current class');
    expect(ctx.memberTriggerHit).toBe(false);
  });
});
