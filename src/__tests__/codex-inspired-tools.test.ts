import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import sharp from 'sharp';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { askUser } from '@mcp/code-agent/tools/interaction.js';
import { viewImage } from '@mcp/code-agent/tools/view-image.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

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

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'view-img-'));
    mkdirSync(join(cwd, 'assets'), { recursive: true });
    const png1x1 = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#fff' } }).png().toBuffer();
    writeFileSync(join(cwd, 'assets', 'pixel.png'), png1x1);
    writeFileSync(join(cwd, 'assets', 'note.txt'), 'not an image');
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('returns extraUserBlocks with an image block on success', async () => {
    const r = await viewImage.handler({ path: 'assets/pixel.png' }, ctx(undefined, cwd));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('original 1×1, preview 1×1');
    expect(r.extraUserBlocks).toBeDefined();
    expect(r.extraUserBlocks).toHaveLength(1);
    const block = r.extraUserBlocks![0];
    expect(block.type).toBe('image');
    if (block.type === 'image') {
      expect(block.mediaType).toBe('image/webp');
      expect(block.base64.length).toBeGreaterThan(0);
      expect((await sharp(Buffer.from(block.base64, 'base64')).metadata()).format).toBe('webp');
    }
  });

  it('rejects non-image extensions', async () => {
    const r = await viewImage.handler({ path: 'assets/note.txt' }, ctx(undefined, cwd));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('unsupported image format');
  });

  it('rejects paths outside the project root', async () => {
    const r = await viewImage.handler({ path: '../escape.png' }, ctx(undefined, cwd));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('outside project root');
  });
});
