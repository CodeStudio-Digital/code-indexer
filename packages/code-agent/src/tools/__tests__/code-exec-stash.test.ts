/**
 * Tests for the session-persistent code_exec stash (P1a pivot).
 *
 * The stash exists so scripts stop echoing whole files into history and stop
 * re-reading files across script calls (the node:vm sandbox dies per call).
 * Core contracts: persistence across code_exec invocations sharing a ctx,
 * JSON round-trip isolation, cap enforcement as a catchable script error,
 * and the ephemeral fallback when ctx has no stash.
 */
import { describe, expect, it } from 'vitest';
import { buildCodeExecTool } from '@mcp/code-agent/tools/code-exec.js';
import {
  createCodeExecStash,
  buildStashSandboxApi,
} from '@mcp/code-agent/tools/code-exec-stash.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

function makeCtx(): ToolContext {
  return {
    cwd: process.cwd(),
    projectName: 'stash-test',
    codeExecStash: createCodeExecStash(),
  };
}

describe('createCodeExecStash', () => {
  it('round-trips JSON values and tracks bytes', () => {
    const stash = createCodeExecStash();
    stash.set('a', { files: ['x.ts', 'y.ts'] });
    expect(stash.get('a')).toEqual({ files: ['x.ts', 'y.ts'] });
    expect(stash.keys()).toEqual(['a']);
    expect(stash.usedBytes()).toBeGreaterThan(0);
    expect(stash.delete('a')).toBe(true);
    expect(stash.usedBytes()).toBe(0);
    expect(stash.get('a')).toBeUndefined();
  });

  it('isolates stored values from later mutation (JSON round-trip)', () => {
    const stash = createCodeExecStash();
    const obj = { n: 1 };
    stash.set('k', obj);
    obj.n = 999;
    expect((stash.get('k') as { n: number }).n).toBe(1);
  });

  it('rejects undefined and unserializable values with clear errors', () => {
    const stash = createCodeExecStash();
    expect(() => stash.set('u', undefined)).toThrow(/undefined/);
    expect(() => stash.set('f', () => 1)).toThrow(/not JSON-serializable/);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => stash.set('c', cyc)).toThrow(/not JSON-serializable/);
  });

  it('enforces the byte cap and names the largest keys', () => {
    const stash = createCodeExecStash(100);
    stash.set('small', 'x'.repeat(40));
    expect(() => stash.set('big', 'y'.repeat(80))).toThrow(/cap 100 bytes exceeded/);
    // Replacing an existing key accounts for the freed bytes.
    stash.set('small', 'z'.repeat(90));
    expect(stash.get('small')).toBe('z'.repeat(90));
  });
});

describe('stash inside code_exec scripts', () => {
  it('persists values ACROSS code_exec calls sharing one ctx', async () => {
    const registry = new ToolRegistry();
    const codeExec = buildCodeExecTool(registry);
    const ctx = makeCtx();

    const w = await codeExec.handler(
      { code: `stash.set('carry', { lines: 42, name: 'gw.php' }); return 'stored';` },
      ctx,
    );
    expect(w.isError).toBeFalsy();

    const r = await codeExec.handler(
      { code: `const v = stash.get('carry'); return v.name + ':' + v.lines;` },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('gw.php:42');
  });

  it('cap overflow surfaces as a catchable script error', async () => {
    const registry = new ToolRegistry();
    const codeExec = buildCodeExecTool(registry);
    const ctx: ToolContext = {
      cwd: process.cwd(),
      projectName: 'stash-test',
      codeExecStash: createCodeExecStash(50),
    };
    const res = await codeExec.handler(
      {
        code: `
          try { stash.set('big', 'x'.repeat(200)); return 'no-throw'; }
          catch (e) { return 'caught: ' + e.message; }
        `,
      },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('caught:');
    expect(res.content).toContain('cap 50 bytes exceeded');
  });

  it('falls back to an ephemeral stash when ctx has none (API always present)', async () => {
    const registry = new ToolRegistry();
    const codeExec = buildCodeExecTool(registry);
    const bare: ToolContext = { cwd: process.cwd(), projectName: 'stash-test' };
    const res = await codeExec.handler(
      { code: `stash.set('k', 1); return String(stash.get('k')) + '/' + stash.keys().length;` },
      bare,
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('1/1');
  });
});

describe('buildStashSandboxApi', () => {
  it('coerces keys to strings and exposes usedBytes', () => {
    const stash = createCodeExecStash();
    const api = buildStashSandboxApi(stash) as {
      set: (k: unknown, v: unknown) => void;
      get: (k: unknown) => unknown;
      usedBytes: () => number;
    };
    api.set(123, 'v');
    expect(api.get('123')).toBe('v');
    expect(api.usedBytes()).toBeGreaterThan(0);
  });
});
