/**
 * Overwrite rule: a whole-file write over an EXISTING path is refused unless
 * this session knows the file's current content (it read the file with a
 * file-read tool — any line range, top level or inside code_exec — or wrote
 * the whole file itself) and the file has not changed on disk since.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatProvider, ChatRequest } from '../../providers/adapter.js';
import type { CoderTool, ToolContext } from '../../core/tool.js';
import { ToolRegistry } from '../../core/registry.js';
import { CoderRunner } from '../../core/runner.js';
import { dispatchTools } from '../../core/runner/nodes/executing-dispatch.js';
import { McpToolBridge } from '../mcp-bridge.js';
import { buildCodeExecTool } from '../code-exec.js';
import { runSubagent } from '../implement-subagent.js';
import { fsTools } from '../fs.js';
import { SessionFileKnowledge, sessionFileKnowledge } from '../file-knowledge.js';

const tool = (name: string) => fsTools.find(t => t.name === name)!;
let root: string;
let ctx: ToolContext;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'overwrite-guard-'));
  ctx = { cwd: root, projectName: 'og', fileKnowledge: new SessionFileKnowledge() } as ToolContext;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const write = (path: string, content: string, c: ToolContext = ctx) => tool('write_file').handler({ path, content }, c);
const disk = (path: string) => readFileSync(join(root, path), 'utf8');

describe('write_file overwrite rule', () => {
  it('creates a new file', async () => {
    expect((await write('new.txt', 'hi')).isError).toBeFalsy();
    expect(disk('new.txt')).toBe('hi');
  });

  it('refuses an existing file the session has not read, leaving it intact', async () => {
    writeFileSync(join(root, 'a.txt'), 'old');
    const res = await write('a.txt', 'new');
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/already exists/);
    expect(res.content).toMatch(/Nothing was written/);
    expect(res.content).toMatch(/read_file/);
    expect(res.guardVerdict).toMatchObject({ action: 'block', refusalKind: 'overwrite-guard' });
    expect(disk('a.txt')).toBe('old');
  });

  it('allows the write after a top-level read, including a partial line range', async () => {
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree');
    await tool('read_file').handler({ path: 'a.txt', start_line: 2, end_line: 2 }, ctx);
    expect((await write('a.txt', 'new')).isError).toBeFalsy();
    expect(disk('a.txt')).toBe('new');
  });

  it('does not count a symbol-only read as knowing the file', async () => {
    writeFileSync(join(root, 'a.ts'), 'function foo() {\n  return 1;\n}\n');
    expect((await tool('read_file').handler({ path: 'a.ts', symbol: 'foo' }, ctx)).isError).toBeFalsy();
    expect((await write('a.ts', 'x')).isError).toBe(true);
  });

  it('counts a read made only inside code_exec', async () => {
    writeFileSync(join(root, 'a.txt'), 'old');
    const registry = new ToolRegistry();
    registry.registerAll(fsTools);
    const codeExec = buildCodeExecTool(registry);
    const res = await codeExec.handler({ code: "await tools.read_file({ path: 'a.txt' }); return 'read';" }, ctx);
    expect(res.isError).toBeFalsy();
    expect((await write('a.txt', 'new')).isError).toBeFalsy();
  });

  it('counts a mcp__read_file read (primary and prefixed names), but not its symbol mode', async () => {
    writeFileSync(join(root, 'a.txt'), 'old');
    writeFileSync(join(root, 'b.ts'), 'function foo() {}\n');
    const fakeClient = {
      listTools: async () => ({ tools: [{ name: 'read_file', inputSchema: { type: 'object', properties: {} } }] }),
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'old' }] })),
    };
    const bridge = new McpToolBridge();
    (bridge as unknown as { client: typeof fakeClient }).client = fakeClient;
    const [mcpRead] = await bridge.listTools({ projectName: 'og', projectRoot: root });
    const prefixed: CoderTool = { ...mcpRead!, name: 'mcp__other__read_file' };
    await prefixed.handler({ file_path: 'b.ts', symbol: 'foo' }, ctx);
    expect((await write('b.ts', 'x')).isError).toBe(true);
    await mcpRead!.handler({ file_path: 'a.txt' }, ctx);
    expect((await write('a.txt', 'new')).isError).toBeFalsy();
  });

  it('refuses after the file changed on disk since the read', async () => {
    writeFileSync(join(root, 'a.txt'), 'old');
    await tool('read_file').handler({ path: 'a.txt' }, ctx);
    writeFileSync(join(root, 'a.txt'), 'changed by the user');
    const res = await write('a.txt', 'new');
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/changed on disk/);
    expect(disk('a.txt')).toBe('changed by the user');
  });

  it("keeps the session's own writes and edits as known content", async () => {
    await write('a.txt', 'first');
    expect((await write('a.txt', 'second')).isError).toBeFalsy();
    await tool('read_file').handler({ path: 'a.txt' }, ctx);
    await tool('edit_file').handler({ path: 'a.txt', old_string: 'second', new_string: 'third' }, ctx);
    expect((await write('a.txt', 'fourth')).isError).toBeFalsy();
    expect(disk('a.txt')).toBe('fourth');
  });

  it('fails closed without a knowledge registry, but still creates new files', async () => {
    writeFileSync(join(root, 'a.txt'), 'old');
    const bare = { cwd: root, projectName: 'og' } as ToolContext;
    expect((await write('a.txt', 'new', bare)).isError).toBe(true);
    expect((await write('fresh.txt', 'ok', bare)).isError).toBeFalsy();
  });

  it('records the refusal kind at the top level and inside code_exec', async () => {
    writeFileSync(join(root, 'a.txt'), 'old');
    const registry = new ToolRegistry();
    registry.registerAll(fsTools);
    registry.register(buildCodeExecTool(registry));
    const nested: Array<{ name: string; refusalKind?: string }> = [];
    const result = await dispatchTools({ registry, turn: 1, toolContext: ctx,
      makeNestedObserver: () => ({ beforeNestedCall: () => null, afterNestedCall: (c) => { nested.push(c); } }),
      toolUses: [{ id: 'w', name: 'write_file', input: { path: 'a.txt', content: 'x' } },
        { id: 'c', name: 'code_exec', input: { code: "try { await tools.write_file({ path: 'a.txt', content: 'y' }); } catch { return 'refused'; }" } }] });
    expect(result.results[0]).toMatchObject({ isError: true, refusalKind: 'overwrite-guard' });
    expect(nested).toEqual([expect.objectContaining({ name: 'write_file', refusalKind: 'overwrite-guard' })]);
    expect(disk('a.txt')).toBe('old');
  });
});

describe('knowledge ownership', () => {
  it('gives every runner its own registry and keeps one supplied by the host', () => {
    const provider = { name: 'p', model: 'm', setModel() {}, async *chat() {} } as unknown as ChatProvider;
    const fresh = {} as ToolContext;
    new CoderRunner({ provider, registry: new ToolRegistry(), systemPrompt: 's', toolContext: fresh });
    expect(fresh.fileKnowledge).toBeInstanceOf(SessionFileKnowledge);
    const supplied = new SessionFileKnowledge();
    const hosted = { fileKnowledge: supplied } as ToolContext;
    new CoderRunner({ provider, registry: new ToolRegistry(), systemPrompt: 's', toolContext: hosted });
    expect(hosted.fileKnowledge).toBe(supplied);
  });

  it('keeps one registry per top-level session across its runs, and separates sessions', async () => {
    const id = `session-${Date.now()}`;
    expect(sessionFileKnowledge(id)).toBe(sessionFileKnowledge(id));
    expect(sessionFileKnowledge(`${id}-other`)).not.toBe(sessionFileKnowledge(id));
    writeFileSync(join(root, 'a.txt'), 'old');
    const firstRun = { cwd: root, projectName: 'og', fileKnowledge: sessionFileKnowledge(id) } as ToolContext;
    await tool('read_file').handler({ path: 'a.txt' }, firstRun);
    const nextRun = { cwd: root, projectName: 'og', fileKnowledge: sessionFileKnowledge(id) } as ToolContext;
    expect((await write('a.txt', 'new', nextRun)).isError).toBeFalsy();
  });

  it("does not let a subagent inherit what its parent read", async () => {
    writeFileSync(join(root, 'a.txt'), 'old');
    await tool('read_file').handler({ path: 'a.txt' }, ctx);
    const seen: string[] = [];
    let turn = 0;
    const provider: ChatProvider = { name: 'p', model: 'm', setModel() {}, async *chat(request: ChatRequest) {
      turn += 1;
      for (const m of request.messages) for (const b of m.content) if (b.type === 'tool_result') seen.push(String(b.content));
      if (turn === 1) {
        yield { type: 'tool_call_end', id: 'w1', name: 'write_file', input: { path: 'a.txt', content: 'child' } };
        yield { type: 'done', stop_reason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'done', stop_reason: 'end_turn' };
    } };
    await runSubagent({ provider, tools: [tool('write_file')], ctx }, {
      systemPrompt: 'Write.', profile: 'implement', allowlist: null, maxTurns: 3,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'overwrite a.txt' }] }],
      limits: { maxToolCalls: 2, timeoutMs: 10_000, stallMs: 10_000 } });
    expect(seen.some(text => /already exists/.test(text))).toBe(true);
    expect(disk('a.txt')).toBe('old');
    expect((await write('a.txt', 'parent')).isError).toBeFalsy();
    expect(existsSync(join(root, 'a.txt'))).toBe(true);
  });
});
