import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { globTool } from '../glob.js';
import type { ToolContext } from '../../core/tool.js';

const fixture = vi.hoisted(() => ({ visits: 0, count: 256 }));
vi.mock('glob', () => ({ glob: async () => Array.from({ length: fixture.count }, (_, i) => `file-${i}.fixture`) }));
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, statSync: (path: string, ...args: unknown[]) => {
    if (!String(path).endsWith('.fixture')) return Reflect.apply(original.statSync, original, [path, ...args]);
    fixture.visits++;
    // Deterministic slow disk metadata, without thousands of real files.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    return { mtimeMs: fixture.visits };
  } };
});

let timer: ReturnType<typeof setInterval> | undefined;
beforeEach(() => { fixture.visits = 0; });
afterEach(() => { if (timer) clearInterval(timer); });
const context = (global: boolean): ToolContext => ({ cwd: process.cwd(), projectName: 'fixture',
  ...(global ? { globalWorkspace: { sessionTitle: 'global', primaryRootPath: process.cwd(),
    projects: [{ projectId: 1, name: 'fixture', slug: 'fixture', rootPath: process.cwd(), isPrimary: true }] } } : {}),
});

describe('large glob host responsiveness', () => {
  it.each([false, true])('services host timers during metadata collection, global=%s', async global => {
    let ticksDuringScan = 0;
    timer = setInterval(() => {
      if (fixture.visits > 0 && fixture.visits < fixture.count) ticksDuringScan++;
    }, 20);
    const result = await globTool.handler({ pattern: '**/*', respect_ignore: false, limit: 10 }, context(global));
    expect(result.isError).toBeFalsy();
    expect(ticksDuringScan).toBeGreaterThan(0);
    expect(result.content).toContain('10 of 256 matches');
    expect(result.content).toContain('file-255.fixture');
    expect(result.content).not.toContain('file-0.fixture');
  });

  it('observes cancellation before scanning the entire result set', async () => {
    const abort = new AbortController();
    timer = setInterval(() => abort.abort(new Error('fixture cancelled')), 20);
    const result = await globTool.handler({ pattern: '**/*', respect_ignore: false }, { ...context(false), signal: abort.signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('fixture cancelled');
    expect(fixture.visits).toBeLessThan(fixture.count);
  });
});
