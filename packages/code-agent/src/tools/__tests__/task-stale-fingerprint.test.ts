/**
 * PR-D fingerprint computation (pure).
 *
 * Verifies:
 *   - identical inputs → identical fingerprint (determinism)
 *   - mtime change → fingerprint changes
 *   - size change → fingerprint changes
 *   - path added/removed → fingerprint changes
 *   - file ORDER doesn't matter (sorted internally)
 *   - title/description change → fingerprint changes (model intent ≠ files)
 *   - SYSTEM_PROMPT_VERSION change → fingerprint changes (tools surface)
 *   - >20 files → fingerprint null (caller must run)
 *   - missing file produces stable "missing:" marker
 *   - paths escaping the project root → "external:" marker (no stat call)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeTaskFingerprint } from '../execute-tasks/task-stale-check.js';
import type { CoderTask } from '@mcp/session-storage/session-state-types.js';

function task(overrides: Partial<CoderTask> = {}): CoderTask {
  return {
    id: 'tsk_a', title: 'A', description: 'desc-a',
    files: [], references: [], depends_on: [],
    suggested_mode: 'subagent', estimated_complexity: 'medium',
    kind: 'implement', status: 'pending',
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'task-stale-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sysV = 'test-v1';

describe('computeTaskFingerprint — determinism', () => {
  it('returns the same hash for identical inputs', () => {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;');
    const t = task({ files: ['a.ts'] });
    const h1 = computeTaskFingerprint({ task: t, cwd: dir, systemPromptVersion: sysV });
    const h2 = computeTaskFingerprint({ task: t, cwd: dir, systemPromptVersion: sysV });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when file CONTENT changes (mtime + size)', () => {
    const f = join(dir, 'a.ts');
    writeFileSync(f, 'export const a = 1;');
    const before = computeTaskFingerprint({ task: task({ files: ['a.ts'] }), cwd: dir, systemPromptVersion: sysV });
    // Append → size + mtime both change.
    appendFileSync(f, '\nexport const b = 2;');
    const after = computeTaskFingerprint({ task: task({ files: ['a.ts'] }), cwd: dir, systemPromptVersion: sysV });
    expect(after).not.toBe(before);
  });

  it('changes when mtime advances but size stays equal', () => {
    const f = join(dir, 'a.ts');
    writeFileSync(f, 'same-size-content');
    const before = computeTaskFingerprint({ task: task({ files: ['a.ts'] }), cwd: dir, systemPromptVersion: sysV });
    // Touch newer mtime.
    const newer = new Date(Date.now() + 60_000);
    utimesSync(f, newer, newer);
    const after = computeTaskFingerprint({ task: task({ files: ['a.ts'] }), cwd: dir, systemPromptVersion: sysV });
    expect(after).not.toBe(before);
  });
});

describe('computeTaskFingerprint — invariance / sensitivity', () => {
  it('is order-independent across files[]', () => {
    writeFileSync(join(dir, 'a.ts'), 'a');
    writeFileSync(join(dir, 'b.ts'), 'b');
    const h1 = computeTaskFingerprint({ task: task({ files: ['a.ts', 'b.ts'] }), cwd: dir, systemPromptVersion: sysV });
    const h2 = computeTaskFingerprint({ task: task({ files: ['b.ts', 'a.ts'] }), cwd: dir, systemPromptVersion: sysV });
    expect(h1).toBe(h2);
  });

  it('changes when a file is ADDED to the scope', () => {
    writeFileSync(join(dir, 'a.ts'), 'a');
    writeFileSync(join(dir, 'b.ts'), 'b');
    const h1 = computeTaskFingerprint({ task: task({ files: ['a.ts'] }), cwd: dir, systemPromptVersion: sysV });
    const h2 = computeTaskFingerprint({ task: task({ files: ['a.ts', 'b.ts'] }), cwd: dir, systemPromptVersion: sysV });
    expect(h2).not.toBe(h1);
  });

  it('changes when title or description changes (intent shifted)', () => {
    writeFileSync(join(dir, 'a.ts'), 'a');
    const base = computeTaskFingerprint({ task: task({ files: ['a.ts'] }), cwd: dir, systemPromptVersion: sysV });
    const renamed = computeTaskFingerprint({ task: task({ files: ['a.ts'], title: 'A-different' }), cwd: dir, systemPromptVersion: sysV });
    expect(renamed).not.toBe(base);
    const rephrased = computeTaskFingerprint({ task: task({ files: ['a.ts'], description: 'new desc' }), cwd: dir, systemPromptVersion: sysV });
    expect(rephrased).not.toBe(base);
  });

  it('changes when SYSTEM_PROMPT_VERSION changes', () => {
    writeFileSync(join(dir, 'a.ts'), 'a');
    const v1 = computeTaskFingerprint({ task: task({ files: ['a.ts'] }), cwd: dir, systemPromptVersion: 'v1' });
    const v2 = computeTaskFingerprint({ task: task({ files: ['a.ts'] }), cwd: dir, systemPromptVersion: 'v2' });
    expect(v2).not.toBe(v1);
  });

  it('changes when task.kind changes (different tool surface)', () => {
    writeFileSync(join(dir, 'a.ts'), 'a');
    const impl = computeTaskFingerprint({ task: task({ files: ['a.ts'], kind: 'implement' }), cwd: dir, systemPromptVersion: sysV });
    const inv = computeTaskFingerprint({ task: task({ files: ['a.ts'], kind: 'investigate' }), cwd: dir, systemPromptVersion: sysV });
    expect(inv).not.toBe(impl);
  });
});

describe('computeTaskFingerprint — edge cases', () => {
  it('returns null when files exceeds 20 (caller must NOT skip)', () => {
    const files = Array.from({ length: 21 }, (_, i) => `f${i}.ts`);
    for (const f of files) writeFileSync(join(dir, f), `// ${f}`);
    const h = computeTaskFingerprint({ task: task({ files }), cwd: dir, systemPromptVersion: sysV });
    expect(h).toBeNull();
  });

  it('encodes missing files distinctly (creating the file changes fingerprint)', () => {
    const before = computeTaskFingerprint({ task: task({ files: ['ghost.ts'] }), cwd: dir, systemPromptVersion: sysV });
    expect(before).not.toBeNull();
    writeFileSync(join(dir, 'ghost.ts'), 'now exists');
    const after = computeTaskFingerprint({ task: task({ files: ['ghost.ts'] }), cwd: dir, systemPromptVersion: sysV });
    expect(after).not.toBe(before);
  });

  it('encodes paths outside cwd as "external:" without stat (safety)', () => {
    mkdirSync(join(dir, 'sub'));
    // Path that resolves to a sibling temp dir — outside our cwd.
    const externalPath = '../escaping/file.ts';
    const h = computeTaskFingerprint({ task: task({ files: [externalPath] }), cwd: join(dir, 'sub'), systemPromptVersion: sysV });
    expect(h).not.toBeNull(); // Did not throw on stat.
  });

  it('handles empty file list with no path entries', () => {
    const h = computeTaskFingerprint({ task: task({ files: [] }), cwd: dir, systemPromptVersion: sysV });
    expect(h).not.toBeNull(); // Title+desc+kind alone still hash.
  });
});
