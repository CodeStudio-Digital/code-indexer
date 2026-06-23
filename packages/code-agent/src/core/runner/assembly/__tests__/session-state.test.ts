/**
 * Session State Block renderer — pure, deterministic; tests pin format,
 * budgets, omissions and hash stability.
 */
import { describe, it, expect } from 'vitest';
import {
  renderSessionStateBlock,
  renderMemoryIndex,
  hashSessionState,
  type SessionStateData,
  type SessionStateBudget,
} from '../session-state.js';

const FULL: SessionStateData = {
  goal: { text: 'Fix the OAuth refresh loop', status: 'in_progress' },
  activePlan: { text: '1) Reproduce 2) Add mutex 3) Regression test', status: 'approved' },
  todos: [
    { status: 'completed', label: 'Reproduce the bug' },
    { status: 'in_progress', label: 'Adding refresh mutex' },
    { status: 'pending', label: 'Regression test' },
  ],
  notes: [
    { id: '1', title: 'token quirk', body: 'refresh_token rotates on EVERY call', kind: 'fact', pinned: true },
    { id: '2', title: 'Fixed: run_command', body: 'After 3 failures…', kind: 'auto:fix', pinned: false },
  ],
  filesChanged: ['src/auth/refresh.ts', 'src/auth/__tests__/refresh.test.ts'],
  investigationCount: 2,
};

const BUDGET: SessionStateBudget = {
  planChars: 700, goalChars: 300, noteSlots: 4, noteChars: 280,
  todoLines: 8, fileSlots: 6, includeLiveState: true,
};

describe('renderSessionStateBlock', () => {
  it('renders every section inside <session-state> tags', () => {
    const block = renderSessionStateBlock(FULL, BUDGET)!;
    expect(block.startsWith('<session-state>')).toBe(true);
    expect(block.endsWith('</session-state>')).toBe(true);
    expect(block).toContain('goal: Fix the OAuth refresh loop (status=in_progress)');
    expect(block).toContain('plan [approved]:');
    expect(block).toContain('(call read_plan for full text)');
    expect(block).toContain('[in_progress] Adding refresh mutex');
    expect(block).toContain('📌 [fact] token quirk');
    expect(block).toContain('files_changed: src/auth/refresh.ts');
    expect(block).toContain('recall: 2 prior investigation(s)');
  });

  it('omits goal/todos when includeLiveState=false (active-context covers them)', () => {
    const block = renderSessionStateBlock(FULL, { ...BUDGET, includeLiveState: false })!;
    expect(block).not.toContain('goal:');
    expect(block).not.toContain('todos:');
    expect(block).toContain('plan [approved]:'); // plan/notes/files stay
    expect(block).toContain('notes:');
  });

  it('returns null when nothing material exists', () => {
    const empty: SessionStateData = {
      goal: null, activePlan: null, todos: [], notes: [], filesChanged: [], investigationCount: 0,
    };
    expect(renderSessionStateBlock(empty, BUDGET)).toBeNull();
  });

  it('truncates by section budget with an ellipsis', () => {
    const block = renderSessionStateBlock(FULL, { ...BUDGET, planChars: 10 })!;
    expect(block).toContain('plan [approved]: 1) Reprodu…');
  });

  it('caps note slots and todo lines', () => {
    const block = renderSessionStateBlock(FULL, { ...BUDGET, noteSlots: 1, todoLines: 1 })!;
    expect(block).toContain('token quirk');
    expect(block).not.toContain('Fixed: run_command');
    // 1 todo line: the in_progress one wins (unfinished first).
    expect(block).toContain('[in_progress] Adding refresh mutex');
    expect(block).not.toContain('[pending] Regression test');
  });

  it('is deterministic — same data + budget → same string and hash', () => {
    const a = renderSessionStateBlock(FULL, BUDGET)!;
    const b = renderSessionStateBlock(FULL, BUDGET)!;
    expect(a).toBe(b);
    expect(hashSessionState(a)).toBe(hashSessionState(b));
    const c = renderSessionStateBlock(
      { ...FULL, notes: [...FULL.notes, { id: '3', title: 'new', body: 'x', kind: 'fact', pinned: false }] },
      BUDGET,
    )!;
    expect(hashSessionState(c)).not.toBe(hashSessionState(a));
  });
});

describe('renderMemoryIndex', () => {
  it('renders one-liners under the char budget', () => {
    const entries = [
      { title: 'Embeddings switch requires re-index', category: 'gotcha' },
      { title: 'Why Verdaccio for DS packages', category: 'decision' },
    ];
    const text = renderMemoryIndex(entries, 1200)!;
    expect(text).toContain('project memory index');
    expect(text).toContain('- [gotcha] Embeddings switch requires re-index');
    expect(text).toContain('- [decision] Why Verdaccio for DS packages');
  });

  it('stops adding entries at the char budget', () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      title: `memory entry number ${i} with a reasonably long title`,
      category: 'note',
    }));
    const text = renderMemoryIndex(entries, 300)!;
    expect(text.length).toBeLessThanOrEqual(320);
    expect(text.split('\n').length).toBeLessThan(10);
  });

  it('returns null for empty entries or zero budget', () => {
    expect(renderMemoryIndex([], 1000)).toBeNull();
    expect(renderMemoryIndex([{ title: 'x', category: 'note' }], 0)).toBeNull();
  });
});
