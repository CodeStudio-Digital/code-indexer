import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { askUser } from '@mcp/code-agent/tools/interaction.js';
import { viewImage } from '@mcp/code-agent/tools/view-image.js';
import { goalTools, _resetGoalForKey } from '@mcp/code-agent/tools/goal.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

const createGoal = goalTools.find((t) => t.name === 'create_goal')!;
const getGoal = goalTools.find((t) => t.name === 'get_goal')!;
const updateGoal = goalTools.find((t) => t.name === 'update_goal')!;

class FakeRunner extends EventEmitter {
  private queue: string[] = [];
  enqueue(r: string) { this.queue.push(r); }
  waitForUserInput(): Promise<string> {
    const next = this.queue.shift();
    if (next === undefined) return Promise.reject(new Error('no input'));
    return Promise.resolve(next);
  }
  approvePlan() { /* no-op */ }
}

function ctx(runner?: FakeRunner, cwd?: string): ToolContext {
  return {
    cwd: cwd ?? '/tmp',
    projectName: 'test',
    runner: (runner ?? new FakeRunner()) as unknown as ToolContext['runner'],
  };
}

// ─── ask_user — tightened schema ─────────────────────────────────

describe('ask_user — tightened schema', () => {
  it('rejects 1 option (must be 2–8)', async () => {
    const runner = new FakeRunner();
    const r = await askUser.handler(
      { question: 'pick', options: [{ label: 'A', value: 'a' }] },
      ctx(runner),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('2–8');
  });

  it('accepts 6 options (was 4 before — bumped cap to 8 for real menu use)', async () => {
    const runner = new FakeRunner();
    runner.enqueue(JSON.stringify({ answer: 'c' }));
    const r = await askUser.handler(
      {
        question: 'Which area to analyze?',
        options: [
          { label: 'Code quality', value: 'quality' },
          { label: 'Architecture', value: 'arch' },
          { label: 'Module', value: 'module' },
          { label: 'Performance', value: 'perf' },
          { label: 'Security', value: 'sec' },
          { label: 'Full analysis', value: 'full' },
        ],
      },
      ctx(runner),
    );
    expect(r.isError).toBeFalsy();
  });

  it('rejects 9 options (above cap)', async () => {
    const runner = new FakeRunner();
    const r = await askUser.handler(
      {
        question: 'pick',
        options: Array.from({ length: 9 }, (_, i) => ({
          label: `O${i}`,
          value: `o${i}`,
        })),
      },
      ctx(runner),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('2–8');
  });

  it('rejects duplicate option values', async () => {
    const runner = new FakeRunner();
    const r = await askUser.handler(
      {
        question: 'pick',
        options: [
          { label: 'A', value: 'same' },
          { label: 'B', value: 'same' },
        ],
      },
      ctx(runner),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('duplicate');
  });

  it('rejects header longer than 40 chars', async () => {
    const runner = new FakeRunner();
    const r = await askUser.handler(
      { question: 'q?', header: 'this header is far too long to be a short ui label' },
      ctx(runner),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('header is too long');
  });

  it('accepts 2 valid options and returns the answer', async () => {
    const runner = new FakeRunner();
    runner.enqueue(JSON.stringify({ answer: 'a' }));
    const r = await askUser.handler(
      {
        question: 'pick',
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' },
        ],
      },
      ctx(runner),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('a');
  });

  it('accepts free-form (no options field)', async () => {
    const runner = new FakeRunner();
    runner.enqueue(JSON.stringify({ answer: 'hello world' }));
    const r = await askUser.handler({ question: 'free?' }, ctx(runner));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('hello world');
  });
});

// ─── view_image ──────────────────────────────────────────────────

describe('view_image', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'view-img-'));
    mkdirSync(join(cwd, 'assets'), { recursive: true });
    // Tiny 1x1 PNG (8 bytes header + IHDR + IDAT + IEND). Use a minimal valid PNG.
    const png1x1 = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da636400000000050001a5f645400000000049454e44ae426082',
      'hex',
    );
    writeFileSync(join(cwd, 'assets', 'pixel.png'), png1x1);
    writeFileSync(join(cwd, 'assets', 'note.txt'), 'not an image');
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('returns extraUserBlocks with an image block on success', async () => {
    const r = await viewImage.handler({ path: 'assets/pixel.png' }, ctx(undefined, cwd));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('image/png');
    expect(r.extraUserBlocks).toBeDefined();
    expect(r.extraUserBlocks).toHaveLength(1);
    const block = r.extraUserBlocks![0];
    expect(block.type).toBe('image');
    if (block.type === 'image') {
      expect(block.mediaType).toBe('image/png');
      expect(block.base64.length).toBeGreaterThan(0);
    }
  });

  it('rejects non-image extensions', async () => {
    const r = await viewImage.handler({ path: 'assets/note.txt' }, ctx(undefined, cwd));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('unsupported extension');
  });

  it('rejects paths outside the project root', async () => {
    const r = await viewImage.handler({ path: '../escape.png' }, ctx(undefined, cwd));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('outside project root');
  });
});

// ─── goal ────────────────────────────────────────────────────────

describe('goal — create / get / update', () => {
  it('reports no goal initially', async () => {
    const runner = new FakeRunner();
    _resetGoalForKey(runner as unknown as object);
    const r = await getGoal.handler({}, ctx(runner));
    expect(r.content).toBe('(no goal set)');
  });

  it('creates a goal and returns it via get_goal', async () => {
    const runner = new FakeRunner();
    _resetGoalForKey(runner as unknown as object);
    const c = await createGoal.handler({ goal: 'Migrate auth to OAuth2' }, ctx(runner));
    expect(c.isError).toBeFalsy();
    expect(c.content).toContain('in_progress');

    const g = await getGoal.handler({}, ctx(runner));
    expect(g.content).toContain('in_progress');
    expect(g.content).toContain('Migrate auth to OAuth2');
  });

  it('acknowledges a redundant create without replacing the active objective', async () => {
    // A repeated call succeeds idempotently; the original objective and
    // its creation timestamp remain unchanged until an explicit transition.
    const runner = new FakeRunner();
    _resetGoalForKey(runner as unknown as object);
    await createGoal.handler({ goal: 'first' }, ctx(runner));
    const original = await getGoal.handler({}, ctx(runner));
    const r = await createGoal.handler({ goal: 'second' }, ctx(runner));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('already in_progress');
    const g = await getGoal.handler({}, ctx(runner));
    expect(g.content).toBe(original.content);
    expect(g.content).toContain('Goal: first');
    expect(g.content).toContain('in_progress');
  });

  it('allows a pivot only after the active goal is completed first', async () => {
    const runner = new FakeRunner();
    _resetGoalForKey(runner as unknown as object);
    await createGoal.handler({ goal: 'phase 1' }, ctx(runner));
    await updateGoal.handler({ status: 'complete' }, ctx(runner));
    const r = await createGoal.handler({ goal: 'phase 2' }, ctx(runner));
    expect(r.isError).toBeFalsy();
    const g = await getGoal.handler({}, ctx(runner));
    expect(g.content).toContain('Goal: phase 2');
    expect(g.content).toContain('in_progress');
  });

  it('marks complete via update_goal', async () => {
    const runner = new FakeRunner();
    _resetGoalForKey(runner as unknown as object);
    await createGoal.handler({ goal: 'ship feature' }, ctx(runner));
    const u = await updateGoal.handler({ status: 'complete', note: 'shipped on master' }, ctx(runner));
    expect(u.isError).toBeFalsy();
    expect(u.content).toContain('shipped on master');

    const g = await getGoal.handler({}, ctx(runner));
    expect(g.content).toContain('complete');
    expect(g.content).toContain('shipped on master');
  });

  it('refuses update when no goal exists', async () => {
    const runner = new FakeRunner();
    _resetGoalForKey(runner as unknown as object);
    const r = await updateGoal.handler({ status: 'complete' }, ctx(runner));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('No goal set');
  });

  it('acknowledges repeated completion without replacing its original note', async () => {
    const runner = new FakeRunner();
    _resetGoalForKey(runner as unknown as object);
    await createGoal.handler({ goal: 'x' }, ctx(runner));
    await updateGoal.handler({ status: 'complete', note: 'verified result' }, ctx(runner));
    const original = await getGoal.handler({}, ctx(runner));
    const r = await updateGoal.handler({ status: 'complete', note: 'replacement note' }, ctx(runner));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('already complete');
    expect((await getGoal.handler({}, ctx(runner))).content).toBe(original.content);
  });

  it('allows a new create after complete (reset cycle)', async () => {
    const runner = new FakeRunner();
    _resetGoalForKey(runner as unknown as object);
    await createGoal.handler({ goal: 'a' }, ctx(runner));
    await updateGoal.handler({ status: 'complete' }, ctx(runner));
    const c2 = await createGoal.handler({ goal: 'b' }, ctx(runner));
    expect(c2.isError).toBeFalsy();
    const g = await getGoal.handler({}, ctx(runner));
    expect(g.content).toContain('Goal: b');
    expect(g.content).toContain('in_progress');
  });

  it('allows successive objectives after each prior objective completes', async () => {
    const runner = new FakeRunner();
    _resetGoalForKey(runner as unknown as object);
    const r1 = await createGoal.handler({ goal: 'phase 1' }, ctx(runner));
    await updateGoal.handler({ status: 'complete' }, ctx(runner));
    const r2 = await createGoal.handler({ goal: 'phase 2' }, ctx(runner));
    await updateGoal.handler({ status: 'complete' }, ctx(runner));
    const r3 = await createGoal.handler({ goal: 'phase 3' }, ctx(runner));
    await updateGoal.handler({ status: 'complete' }, ctx(runner));
    const r4 = await createGoal.handler({ goal: 'phase 4' }, ctx(runner));
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    expect(r3.isError).toBeFalsy();
    expect(r4.isError).toBeFalsy();
  });

  it('keeps repeated creates idempotent for the same active objective', async () => {
    const runner = new FakeRunner();
    _resetGoalForKey(runner as unknown as object);
    await createGoal.handler({ goal: 'active objective' }, ctx(runner));
    const original = await getGoal.handler({}, ctx(runner));
    await createGoal.handler({ goal: 'rewrite 1' }, ctx(runner));
    await createGoal.handler({ goal: 'rewrite 2' }, ctx(runner));
    await createGoal.handler({ goal: 'rewrite 3' }, ctx(runner));
    const repeated = await createGoal.handler({ goal: 'rewrite 4' }, ctx(runner));
    expect(repeated.isError).toBeFalsy();
    expect(repeated.content).toContain('already in_progress');
    expect((await getGoal.handler({}, ctx(runner))).content).toBe(original.content);
  });

  it('returns a quiet success message — no in-result nudge that would re-prime the model', async () => {
    // The earlier "DO NOT call create_goal again" tail was paradoxically
    // reinforcing the loop by keeping the tool name in the model's context.
    // Repeated calls preserve the current objective, so the success body
    // needs no warning or escalation instruction.
    const runner = new FakeRunner();
    _resetGoalForKey(runner as unknown as object);
    const r1 = await createGoal.handler({ goal: 'phase 1' }, ctx(runner));
    expect(r1.isError).toBeFalsy();
    expect(r1.content).not.toContain('DO NOT call create_goal');
    expect(r1.content).toContain('Goal set');
  });

  it('different runners retain independent objectives after repeated creates', async () => {
    const r1 = new FakeRunner();
    const r2 = new FakeRunner();
    _resetGoalForKey(r1 as unknown as object);
    _resetGoalForKey(r2 as unknown as object);
    // Repeated calls cannot overwrite r1 or affect r2's objective.
    await createGoal.handler({ goal: 'a1' }, ctx(r1));
    await createGoal.handler({ goal: 'a2' }, ctx(r1));
    await createGoal.handler({ goal: 'a3' }, ctx(r1));
    await createGoal.handler({ goal: 'a4' }, ctx(r1));
    const a5 = await createGoal.handler({ goal: 'a5' }, ctx(r1));
    expect(a5.isError).toBeFalsy();
    const b1 = await createGoal.handler({ goal: 'b1' }, ctx(r2));
    expect(b1.isError).toBeFalsy();
    expect((await getGoal.handler({}, ctx(r1))).content).toContain('Goal: a1');
    expect((await getGoal.handler({}, ctx(r2))).content).toContain('Goal: b1');
  });
});
