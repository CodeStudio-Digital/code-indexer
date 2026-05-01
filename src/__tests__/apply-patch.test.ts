/**
 * Tests for the `apply_patch` Codex-style freeform editor.
 *
 * Covers:
 *   - Parser: Add / Update / Delete / Move actions, multiple hunks per file.
 *   - Applier: writes new files, mutates existing, deletes, moves.
 *   - Tool handler: parses raw input, surfaces errors cleanly.
 *   - Provider wiring: chatgpt provider sends apply_patch as `type: 'custom'`
 *     when applyPatchToolType='freeform', as `function` otherwise.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseApplyPatch,
  applyParsedPatch,
  applyPatchTool,
} from '../core/coder/tools/apply-patch.js';
import { ChatGPTCodexProvider } from '../core/coder/providers/chatgpt.js';
import type { ChatRequest } from '../core/coder/providers/adapter.js';
import type { ToolContext } from '../core/coder/core/tool.js';

async function* events(...evts: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
  for (const e of evts) yield e;
}

function makeCtx(cwd: string): ToolContext {
  return {
    cwd,
    projectName: 'test',
    overlay: undefined,
    signal: undefined,
    planMode: false,
  } as unknown as ToolContext;
}

describe('apply_patch parser', () => {
  it('parses Add File action with multiple lines', () => {
    const patch = `*** Begin Patch
*** Add File: src/foo.ts
+export const x = 1;
+export const y = 2;
*** End Patch`;
    const parsed = parseApplyPatch(patch);
    expect(parsed.actions).toHaveLength(1);
    const a = parsed.actions[0];
    expect(a.kind).toBe('add');
    if (a.kind === 'add') {
      expect(a.path).toBe('src/foo.ts');
      expect(a.lines).toEqual(['export const x = 1;', 'export const y = 2;']);
    }
  });

  it('parses Delete File action', () => {
    const patch = `*** Begin Patch
*** Delete File: dead.ts
*** End Patch`;
    const parsed = parseApplyPatch(patch);
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0]).toEqual({ kind: 'delete', path: 'dead.ts' });
  });

  it('parses Update File with one hunk', () => {
    const patch = `*** Begin Patch
*** Update File: src/foo.ts
@@ context
 unchanged top
-old line
+new line
 unchanged bottom
*** End Patch`;
    const parsed = parseApplyPatch(patch);
    expect(parsed.actions).toHaveLength(1);
    const a = parsed.actions[0];
    expect(a.kind).toBe('update');
    if (a.kind === 'update') {
      expect(a.path).toBe('src/foo.ts');
      expect(a.hunks).toHaveLength(1);
      const h = a.hunks[0];
      expect(h.contextBefore).toEqual(['unchanged top']);
      expect(h.removed).toEqual(['old line']);
      expect(h.added).toEqual(['new line']);
      expect(h.contextAfter).toEqual(['unchanged bottom']);
    }
  });

  it('parses Update File with Move to', () => {
    const patch = `*** Begin Patch
*** Update File: old.ts
*** Move to: new.ts
@@
-old
+new
*** End Patch`;
    const parsed = parseApplyPatch(patch);
    const a = parsed.actions[0];
    if (a.kind === 'update') {
      expect(a.path).toBe('old.ts');
      expect(a.movePath).toBe('new.ts');
    }
  });

  it('parses multiple actions in one patch', () => {
    const patch = `*** Begin Patch
*** Add File: a.ts
+a
*** Update File: b.ts
@@
-old
+new
*** Delete File: c.ts
*** End Patch`;
    const parsed = parseApplyPatch(patch);
    expect(parsed.actions.map((a) => a.kind)).toEqual(['add', 'update', 'delete']);
  });

  it('throws when missing Begin Patch header', () => {
    expect(() => parseApplyPatch('*** Add File: x\n+a\n*** End Patch')).toThrow(/missing/);
  });
});

describe('apply_patch applier', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apply-patch-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('Add File creates a new file', async () => {
    const ctx = makeCtx(dir);
    const patch = parseApplyPatch(`*** Begin Patch
*** Add File: hello.txt
+line one
+line two
*** End Patch`);
    const r = await applyParsedPatch(patch, ctx);
    expect(r.added).toEqual(['hello.txt']);
    expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toBe('line one\nline two');
  });

  it('Update File replaces matched hunk', async () => {
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'foo.ts'), 'const x = 1;\nconst y = 2;\nconst z = 3;\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: foo.ts
@@
 const x = 1;
-const y = 2;
+const y = 42;
 const z = 3;
*** End Patch`);
    const r = await applyParsedPatch(patch, ctx);
    expect(r.updated).toEqual(['foo.ts']);
    expect(readFileSync(join(dir, 'foo.ts'), 'utf8')).toBe(
      'const x = 1;\nconst y = 42;\nconst z = 3;\n',
    );
  });

  it('Delete File removes the file', async () => {
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'dead.txt'), 'goodbye');
    const patch = parseApplyPatch(`*** Begin Patch
*** Delete File: dead.txt
*** End Patch`);
    const r = await applyParsedPatch(patch, ctx);
    expect(r.deleted).toEqual(['dead.txt']);
    expect(existsSync(join(dir, 'dead.txt'))).toBe(false);
  });

  it('throws when Update hunk does not match source', async () => {
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'foo.ts'), 'completely different content');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: foo.ts
@@
-old
+new
*** End Patch`);
    await expect(applyParsedPatch(patch, ctx)).rejects.toThrow(/did not match/);
  });
});

describe('apply_patch tool handler', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apply-patch-tool-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts patch via `patch` arg (function-tool path)', async () => {
    const ctx = makeCtx(dir);
    const result = await applyPatchTool.handler(
      {
        patch: `*** Begin Patch
*** Add File: x.txt
+hi
*** End Patch`,
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(existsSync(join(dir, 'x.txt'))).toBe(true);
  });

  it('accepts patch via `_raw` arg (custom-tool path)', async () => {
    const ctx = makeCtx(dir);
    const result = await applyPatchTool.handler(
      {
        _raw: `*** Begin Patch
*** Add File: y.txt
+raw
*** End Patch`,
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(existsSync(join(dir, 'y.txt'))).toBe(true);
  });

  it('returns isError when patch is empty', async () => {
    const r = await applyPatchTool.handler({}, makeCtx(dir));
    expect(r.isError).toBe(true);
  });
});

describe('chatgpt provider sends apply_patch in correct shape', () => {
  const baseReq: ChatRequest = {
    messages: [],
    system: 'sys',
    tools: [
      {
        name: 'apply_patch',
        description: 'apply codex patch',
        parameters: {
          type: 'object',
          properties: { patch: { type: 'string' } },
          required: ['patch'],
        },
      },
      {
        name: 'read_file',
        description: 'read',
        parameters: { type: 'object', properties: {} },
      },
    ],
  };

  function makeProvider(applyPatchToolType: string | null) {
    const provider = new ChatGPTCodexProvider({
      apiKey: 'tok',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      accountId: 'acct',
      model: 'gpt-5.5',
      applyPatchToolType,
    });
    const create = vi
      .fn()
      .mockResolvedValue(
        events({ type: 'response.completed', response: { usage: {}, status: 'completed' } }),
      );
    (provider as unknown as { client: { responses: { create: typeof create } } }).client = {
      responses: { create },
    };
    return { provider, create };
  }

  it('sends apply_patch as type:custom when applyPatchToolType=freeform', async () => {
    const { provider, create } = makeProvider('freeform');
    for await (const _ of provider.chat(baseReq)) {
      void _;
    }
    const args = create.mock.calls[0][0] as Record<string, unknown>;
    const tools = args.tools as Array<{ type: string; name: string; parameters?: unknown }>;
    const patchTool = tools.find((t) => t.name === 'apply_patch');
    expect(patchTool?.type).toBe('custom');
    expect(patchTool?.parameters).toBeUndefined();
    const readTool = tools.find((t) => t.name === 'read_file');
    expect(readTool?.type).toBe('function');
  });

  it('sends apply_patch as type:function when applyPatchToolType is null', async () => {
    const { provider, create } = makeProvider(null);
    for await (const _ of provider.chat(baseReq)) {
      void _;
    }
    const args = create.mock.calls[0][0] as Record<string, unknown>;
    const tools = args.tools as Array<{ type: string; name: string; parameters?: unknown }>;
    const patchTool = tools.find((t) => t.name === 'apply_patch');
    expect(patchTool?.type).toBe('function');
    expect(patchTool?.parameters).toBeDefined();
  });
});

// ─── boilerplate for vitest globals ───
import { beforeEach, afterEach } from 'vitest';
