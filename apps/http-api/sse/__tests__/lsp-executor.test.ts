import { describe, expect, it } from 'vitest';
import { ErrRequestTimeout } from '@mcp/orchestrator-host';
import {
  EMPTY_RESULTS as LSP_EMPTY_RESULTS,
  type LspBackendExecutor,
  type LspOpCtx,
} from '@mcp/api-handlers/lsp/executor-types.js';
import { allDocs, openDoc, closeDoc } from '@mcp/api-handlers/lsp/document-store.js';
import { wrapLspExecutorWithFallback, createLspExecutor } from '../lsp-executor.js';

const CTX: LspOpCtx = { projectId: 1, root: 'd:/proj', file: 'src/a.ts' };

function stub(impl: (op: string) => Promise<unknown>): LspBackendExecutor {
  const out = {} as Record<string, (ctx: LspOpCtx) => Promise<unknown>>;
  for (const op of Object.keys(LSP_EMPTY_RESULTS)) out[op] = () => impl(op);
  return out as unknown as LspBackendExecutor;
}

describe('wrapLspExecutorWithFallback', () => {
  it('passes results through when the primary succeeds', async () => {
    const wrapped = wrapLspExecutorWithFallback(
      stub(async () => [{ name: 'fromWorker' }]),
      stub(async () => [{ name: 'fromFallback' }]),
    );
    expect(await wrapped.tsCompletions(CTX)).toEqual([{ name: 'fromWorker' }]);
  });

  it('falls back in-process when the worker is unavailable', async () => {
    const calls: string[] = [];
    const wrapped = wrapLspExecutorWithFallback(
      stub(async () => { throw Object.assign(new Error('gone'), { code: 'port_closed' }); }),
      stub(async (op) => { calls.push(op); return [] as unknown[]; }),
    );
    await wrapped.fallbackCompletion(CTX);
    await wrapped.tsHover(CTX);
    expect(calls).toEqual(['fallbackCompletion', 'tsHover']);
  });

  it('answers EMPTY on timeout instead of re-running on the main thread', async () => {
    let fallbackCalled = false;
    const wrapped = wrapLspExecutorWithFallback(
      stub(async () => { throw new ErrRequestTimeout('slow'); }),
      stub(async () => { fallbackCalled = true; return [{ name: 'x' }]; }),
    );
    expect(await wrapped.tsCompletions(CTX)).toEqual([]);
    expect(await wrapped.tsHover(CTX)).toBeNull();
    expect(await wrapped.tsDefinition(CTX)).toEqual({ targets: [] });
    expect(fallbackCalled).toBe(false);
  });
});

describe('createLspExecutor kill switch', () => {
  it('returns the fallback alone when MCP_LSP_WORKER=0', () => {
    const prev = process.env.MCP_LSP_WORKER;
    process.env.MCP_LSP_WORKER = '0';
    try {
      const fallback = stub(async () => []);
      const { executor, client } = createLspExecutor({ dbPath: ':memory:' }, fallback);
      expect(executor).toBe(fallback);
      expect(client).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.MCP_LSP_WORKER;
      else process.env.MCP_LSP_WORKER = prev;
    }
  });
});

describe('document-store allDocs', () => {
  it('lists every open doc across projects with parsed keys', () => {
    openDoc(91, 'src/with:colon.ts', 'typescript', 3, 'abc');
    openDoc(92, 'b.py', 'python', 1, 'x');
    try {
      const all = allDocs();
      const mine = all.filter((d) => d.projectId === 91 || d.projectId === 92);
      expect(mine).toHaveLength(2);
      const first = mine.find((d) => d.projectId === 91)!;
      expect(first.file).toBe('src/with:colon.ts'); // split on FIRST ':' only
      expect(first.doc.version).toBe(3);
    } finally {
      closeDoc(91, 'src/with:colon.ts');
      closeDoc(92, 'b.py');
    }
  });
});
