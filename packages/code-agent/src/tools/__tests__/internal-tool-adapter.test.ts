/**
 * The shared adapter on the native route (an in-process port): each scripted
 * index answer must become the expected ToolResult, with the expected
 * dispatched arguments and side effects.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { CoderTool, ToolContext } from '../../core/tool.js';
import { buildNativeIndexTools } from '../native-index-tools.js';
import { SessionFileKnowledge } from '../file-knowledge.js';
import { SessionOverlay } from '../../overlay/session-overlay.js';
import type { IndexToolCatalogEntry, IndexToolsPort } from '../../ports/index-tools-port.js';

type Call = { name: string; args: Record<string, unknown> };
const WINDOW = { technique: 'mcp-read-file-line-window', inputSize: 900, outputSize: 400, unit: 'lines', recoverable: true };
const PROJECT = 'adapter-project';
const BIG = `${'x'.repeat(300)}\n`.repeat(3_000);
const entry = (name: string, ...props: string[]): IndexToolCatalogEntry => ({ name, description: name,
  inputSchema: { type: 'object', properties: Object.fromEntries(['project_name', ...props].map(p => [p, { type: 'string' }])), required: ['project_name'] } });
/** Every one of these real tools declares project_name, like the published catalog. */
const CATALOG = [entry('grep_code', 'pattern'), entry('read_file', 'file_path', 'symbol', 'max_lines'), entry('get_costs', 'since'),
  entry('save_memory', 'title', 'category', 'content'), entry('list_directory', 'path'), entry('search', 'query'),
  entry('get_file_skeleton', 'file_path')];

/** One scripted index core; `hang` waits until the caller aborts. */
async function respond(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  if (args.query === 'hang' || args.title === 'hang') {
    await new Promise<void>((_resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
  switch (name) {
    case 'read_file': return { content: [{ type: 'text', text: 'one\ntwo' }],
      structuredContent: { path: args.file_path, lines: 2 }, _meta: { sourceTruncations: [WINDOW] } };
    case 'get_costs': return { content: [{ type: 'text', text: 'Error: since must be a valid ISO date or timestamp with timezone' }], isError: true };
    case 'save_memory': return { content: [{ type: 'text', text: 'Owner lost confirmation.' }], isError: true, _meta: { effectOutcome: 'unknown' } };
    case 'list_directory': return { content: [{ type: 'text', text: BIG }] };
    default: return { content: [{ type: 'text', text: `${name} ok ${JSON.stringify(args)}` }] };
  }
}

const calls: Call[] = [];
const port: IndexToolsPort = {
  catalog: () => structuredClone(CATALOG),
  invoke: async (name, args, { signal }) => {
    calls.push({ name, args: JSON.parse(JSON.stringify(args)) });
    return JSON.parse(JSON.stringify(await respond(name, args, signal)));
  },
};
let root: string;
let tools = new Map<string, CoderTool>();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'internal-tool-adapter-'));
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
  tools = new Map(buildNativeIndexTools({ port, db: {} as CodeIndexDB, binding: { projectName: PROJECT, projectRoot: root } })
    .map(tool => [tool.name, tool]));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function toolCtx(extra: Partial<ToolContext> = {}): ToolContext {
  return { cwd: root, sessionId: 's-adapter', toolOutputCapLevel: 'economic', fileKnowledge: new SessionFileKnowledge(),
    signal: new AbortController().signal, ...extra } as ToolContext;
}

/** One call on the native route; returns the result, its context and what reached the port. */
async function call(name: string, args: Record<string, unknown>, extra: Partial<ToolContext> = {}) {
  const from = calls.length;
  const ctx = toolCtx(extra);
  const result = await tools.get(`mcp__${name}`)!.handler(structuredClone(args), ctx);
  return { result, ctx, calls: calls.slice(from) };
}

const aborted = () => { const controller = new AbortController(); controller.abort(new Error('stopped')); return controller.signal; };
const abortSoon = () => { const controller = new AbortController(); setTimeout(() => controller.abort(new Error('stopped')), 40); return controller.signal; };
const imported = [{ ...WINDOW, recoverable: false }];
const unknownOutcome = { code: 'TOOL_OUTCOME_UNKNOWN', kind: 'network', retryable: false,
  suggestedAction: 'Reconcile the original operation before authorizing another mutation.' };

describe('internal tool adapter: native route', () => {
  it.each([
    ['plain text with project_name injected', 'grep_code', { pattern: 'x' },
      { content: `grep_code ok ${JSON.stringify({ pattern: 'x', project_name: PROJECT })}` }],
    ['structured content and producer truncations', 'read_file', { file_path: 'a.txt' },
      { content: 'one\ntwo', structuredData: { path: 'a.txt', lines: 2 }, sourceTruncations: imported }],
    ['read_file clamp note', 'read_file', { file_path: 'a.txt', max_lines: 5_000 },
      { content: '[note: max_lines clamped from 5000 to 800 by bridge]\none\ntwo', structuredData: { path: 'a.txt', lines: 2 }, sourceTruncations: imported }],
    ['server error text', 'get_costs', { since: 'bad' },
      { content: 'Error: since must be a valid ISO date or timestamp with timezone', isError: true, error: { code: 'INVALID_ARGUMENTS',
        kind: 'invalid_input', retryable: false, suggestedAction: 'Inspect the tool schema and correct the arguments before retrying.' } }],
    ['lost mutation confirmation', 'save_memory', { title: 't', category: 'decision', content: 'c' },
      { content: 'Owner lost confirmation.', isError: true, error: unknownOutcome, effectOutcome: 'unknown' }],
    ['pathological output guard (raw payload kept for the runner spill)', 'list_directory', {}, { content: BIG }],
  ])('%s', async (_label, name, args, expected) => {
    const run = await call(name, args);
    expect(run.result).toEqual(expected);
    expect(run.calls).toEqual([{ name, args: { ...args, project_name: PROJECT, ...(name === 'read_file' && 'max_lines' in args ? { max_lines: 800 } : {}) } }]);
  });

  it('clamps by the session cap level', async () => {
    const run = await call('read_file', { file_path: 'a.txt', max_lines: 50_000 }, { toolOutputCapLevel: 'max' });
    expect(run.result.content).toBe('[note: max_lines clamped from 50000 to 5000 by bridge]\none\ntwo');
    expect(run.calls).toEqual([{ name: 'read_file', args: { file_path: 'a.txt', max_lines: 5_000, project_name: PROJECT } }]);
  });

  it('records file knowledge after read_file, and none for a symbol read', async () => {
    const full = await call('read_file', { file_path: 'a.txt' });
    expect(full.ctx.fileKnowledge!.state(join(root, 'a.txt'), 'one\ntwo\n')).toBe('known');
    const symbol = await call('read_file', { file_path: 'a.txt', symbol: 'one' });
    expect(symbol.ctx.fileKnowledge!.state(join(root, 'a.txt'), 'one\ntwo\n')).toBe('unknown');
  });

  it('forwards session and Company ids to semantic tools', async () => {
    const run = await call('search', { query: 'q' }, { companyContext: { companySessionId: 'c-1' } as ToolContext['companyContext'] });
    const sent = { query: 'q', project_name: PROJECT, __mcp_session_id: 's-adapter', __mcp_company_session_id: 'c-1' };
    expect(run.result).toEqual({ content: `search ok ${JSON.stringify(sent)}` });
    expect(run.calls).toEqual([{ name: 'search', args: sent }]);
  });

  it('answers an enforced memory save from its owned port without dispatching', async () => {
    const invoke = async () => ({ created: 0, merged: 1 });
    const mutationFence = { mode: 'enforce', assertMutation: () => undefined } as unknown as ToolContext['mutationFence'];
    const run = await call('save_memory', { title: 't', category: 'decision', content: 'c' },
      { mutationFence, ports: { memoryMutations: { invoke } } as unknown as ToolContext['ports'] });
    expect(run.result).toMatchObject({ content: 'Memory "t" merged into existing memory (created=0 merged=1).' });
    expect(run.result.isError).toBeFalsy();
    expect(run.calls).toEqual([]);
  });

  it('refuses before dispatch when the call is already cancelled', async () => {
    const run = await call('grep_code', { pattern: 'x' }, { signal: aborted() });
    expect(run.result).toEqual({ content: 'MCP call cancelled before dispatch.', isError: true,
      error: { code: 'MCP_CALL_CANCELLED', kind: 'cancelled', retryable: false } });
    expect(run.calls).toEqual([]);
  });

  it('reports a read cancelled mid-call and an unknown outcome for a write', async () => {
    const read = await call('search', { query: 'hang' }, { signal: abortSoon() });
    expect(read.result).toEqual({ content: "MCP read 'search' was cancelled.", isError: true,
      error: { code: 'MCP_CALL_CANCELLED', kind: 'cancelled', retryable: false } });
    const write = await call('save_memory', { title: 'hang', category: 'decision', content: 'c' }, { signal: abortSoon() });
    expect(write.result).toEqual({ content: "MCP tool 'save_memory' lost confirmation after dispatch. Its effect may have completed. "
      + 'Reconcile the original operation before authorizing another mutation.', isError: true, error: unknownOutcome, effectOutcome: 'unknown' });
    expect([...read.calls, ...write.calls].map(c => c.name)).toEqual(['search', 'save_memory']);
  });

  it('sends a dirty file read to the core, and a dirty skeleton with __prefer_disk', async () => {
    const overlay = () => { const o = new SessionOverlay(root); o.mark('a.txt'); return { overlay: o }; };
    const read = await call('read_file', { file_path: 'a.txt' }, overlay());
    // read_file has no overlay handler: the core reads the current disk bytes.
    expect(read.result).toEqual({ content: 'one\ntwo', structuredData: { path: 'a.txt', lines: 2 }, sourceTruncations: imported });
    expect(read.calls).toEqual([{ name: 'read_file', args: { file_path: 'a.txt', project_name: PROJECT } }]);
    const skeleton = await call('get_file_skeleton', { file_path: 'a.txt' }, overlay());
    expect(skeleton.calls).toEqual([{ name: 'get_file_skeleton', args: { file_path: 'a.txt', project_name: PROJECT, __prefer_disk: true } }]);
    const clean = await call('get_file_skeleton', { file_path: 'b.txt' }, overlay());
    expect(clean.calls[0].args).not.toHaveProperty('__prefer_disk');
  });

  it('drops every __* key the model sends before injecting internal arguments', async () => {
    const forged = { pattern: 'x', __mcp_session_id: 'forged', __mcp_company_session_id: 'forged', __prefer_disk: true, __other: 1 };
    const grep = await call('grep_code', forged, { sessionId: undefined });
    expect(grep.calls[0].args).toEqual({ pattern: 'x', project_name: PROJECT });
    const search = await call('search', { query: 'q', __mcp_session_id: 'forged', __mcp_company_session_id: 'forged' });
    expect(search.calls[0].args).toEqual({ query: 'q', project_name: PROJECT, __mcp_session_id: 's-adapter' });
    const skeleton = await call('get_file_skeleton', { file_path: 'a.txt', __prefer_disk: true });
    expect(skeleton.calls[0].args).toEqual({ file_path: 'a.txt', project_name: PROJECT });
  });

  it('routes an enforced memory save to the owned port', async () => {
    const run = await call('save_memory', { title: 't', category: 'decision', content: 'c' },
      { mutationFence: { mode: 'enforce' } as ToolContext['mutationFence'] });
    expect(run.result).toEqual({ content: 'Memory save requires its owned persistence port.', isError: true });
    expect(run.calls).toEqual([]);
  });
});
