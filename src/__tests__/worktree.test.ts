import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  enterWorktree,
  exitWorktree,
  createProjectWorktree,
} from '@mcp/code-agent/tools/worktree.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

// ── Helpers ─────────────────────────────────────────────────────────

const ctx = (cwd = '/fake/project'): ToolContext => ({ cwd, projectName: 'test' });

interface MockRunner {
  worktreePath?: string;
  originalCwd?: string;
  cwd: string;
  enterWorktreeScope: ReturnType<typeof vi.fn>;
  exitWorktreeScope: ReturnType<typeof vi.fn>;
}

function makeRunner(cwd = '/fake/project'): MockRunner {
  return {
    worktreePath: undefined,
    originalCwd: cwd,
    cwd,
    enterWorktreeScope: vi.fn((abs: string) => {
      // Simulate what the real runner does
      const r = makeRunner(cwd);
      r.worktreePath = abs;
      return r;
    }),
    exitWorktreeScope: vi.fn(() => {
      // Simulate what the real runner does
      const r = makeRunner(cwd);
      r.worktreePath = undefined;
      return r;
    }),
  };
}

// ── createProjectWorktree (unit, no git) ────────────────────────────

describe('createProjectWorktree', () => {
  it('validates worktree name format', async () => {
    // Only letters, digits, dot, underscore, dash allowed
    const result = await createProjectWorktree('/fake', { name: 'bad name!' });
    expect(result.ok).toBe(false);
  });

  it('validates worktree name length (max 64)', async () => {
    const longName = 'a'.repeat(65);
    const result = await createProjectWorktree('/fake', { name: longName });
    expect(result.ok).toBe(false);
  });


});

// ── enter_worktree ──────────────────────────────────────────────────

describe('enter_worktree', () => {
  it('returns error when runner lacks worktree support', async () => {
    const result = await enterWorktree.handler({ name: 'test' }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('runner that supports worktree');
  });

  it('returns error when already inside a worktree', async () => {
    const runner = makeRunner();
    runner.worktreePath = '/fake/project/.mcp-indexer/worktrees/existing';
    const result = await enterWorktree.handler(
      { name: 'another' },
      { ...ctx(), runner } as any,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Already inside a worktree');
  });




});

// ── exit_worktree ───────────────────────────────────────────────────

describe('exit_worktree', () => {
  it('returns ok when no worktree is active', async () => {
    const runner = makeRunner();
    runner.worktreePath = undefined;
    const result = await exitWorktree.handler(
      { action: 'keep' },
      { ...ctx(), runner } as any,
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('No worktree');
  });

  it('returns error when runner lacks worktree support', async () => {
    const result = await exitWorktree.handler({ action: 'keep' }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('runner that supports worktree');
  });

  it('rejects invalid action values', async () => {
    const runner = makeRunner();
    runner.worktreePath = '/fake/project/.mcp-indexer/worktrees/test';
    const result = await exitWorktree.handler(
      { action: 'invalid' },
      { ...ctx(), runner } as any,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"keep" or "remove"');
  });

  it('action:"keep" calls exitWorktreeScope and restores cwd', async () => {
    const runner = makeRunner();
    runner.worktreePath = '/fake/project/.mcp-indexer/worktrees/test';
    const result = await exitWorktree.handler(
      { action: 'keep' },
      { ...ctx(), runner } as any,
    );
    expect(result.isError).toBeFalsy();
    expect(runner.exitWorktreeScope).toHaveBeenCalledTimes(1);
    expect(result.content).toContain('kept on disk');
    expect(result.content).toContain('restored');
  });

  it('action:"remove" cannot switch scope when the managed path is missing', async () => {
    const runner = makeRunner();
    runner.worktreePath = '/fake/project/.mcp-indexer/worktrees/test';
    const result = await exitWorktree.handler(
      { action: 'remove' },
      { ...ctx(), runner } as any,
    );
    expect(runner.exitWorktreeScope).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('restored');
  });

  it('action:"remove" cannot infer a clean worktree from an unavailable directory', async () => {
    const runner = makeRunner();
    runner.worktreePath = '/fake/project/.mcp-indexer/worktrees/test';
    const result = await exitWorktree.handler(
      { action: 'remove' },
      { ...ctx(), runner } as any,
    );
    expect(result.isError).toBe(true);
    expect(runner.exitWorktreeScope).not.toHaveBeenCalled();
  });
});
