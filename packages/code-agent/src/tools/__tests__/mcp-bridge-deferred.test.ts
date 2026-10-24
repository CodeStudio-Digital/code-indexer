import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../core/tool.js';
import { INTERNAL_MCP_CATALOG } from '../generated/internal-mcp-catalog.js';

const fake = vi.hoisted(() => ({ connects: vi.fn(), closes: vi.fn(), lists: vi.fn(), calls: vi.fn(), transports: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class {
  connect = fake.connects; close = fake.closes; listTools = fake.lists; callTool = fake.calls;
} }));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class { constructor() { fake.transports(); } } }));
import { McpToolBridge } from '../mcp-bridge.js';

beforeEach(() => {
  vi.clearAllMocks();
  fake.connects.mockResolvedValue(undefined); fake.closes.mockResolvedValue(undefined);
  fake.lists.mockImplementation(async () => ({ tools: structuredClone(INTERNAL_MCP_CATALOG) }));
  fake.calls.mockResolvedValue({ content: [{ type: 'text', text: 'owned result' }] });
});
const ctx = (signal?: AbortSignal) => ({ cwd: process.cwd(), projectName: 'owned', signal }) as ToolContext;

describe('deferred first-party MCP preparation', () => {
  it('prepares isolated schemas and owned agent reads without starting a process', async () => {
    const bridge = new McpToolBridge({ deferConnection: true });
    const tools = await bridge.listTools({ projectName: 'owned' });
    expect(tools).toHaveLength(INTERNAL_MCP_CATALOG.length);
    const original = JSON.stringify(INTERNAL_MCP_CATALOG);
    tools[0]!.parameters.required = ['local_edit'];
    expect(JSON.stringify(INTERNAL_MCP_CATALOG)).toBe(original);
    const read = vi.fn(async () => ({ runs: [] }));
    await tools.find(tool => tool.name === 'mcp__list_agent_runs')!.handler({}, { ...ctx(), agentReads: { read } });
    expect(read).toHaveBeenCalledOnce(); expect(fake.transports).not.toHaveBeenCalled();
    await bridge.close(); expect(fake.closes).not.toHaveBeenCalled();
    const closed = await tools.find(tool => tool.name === 'mcp__list_agent_runs')!.handler({}, { ...ctx(), agentReads: { read } });
    expect(closed.isError).toBe(true); expect(read).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent first reads into one connection and checks its live schema', async () => {
    // A protocol decoder may reorder object keys without changing the schema.
    fake.lists.mockImplementation(async () => ({ tools: structuredClone(INTERNAL_MCP_CATALOG).map(tool => ({
      ...tool, inputSchema: Object.fromEntries(Object.entries(tool.inputSchema).reverse()),
    })) }));
    let finish!: () => void;
    fake.connects.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const bridge = new McpToolBridge({ deferConnection: true });
    const tools = await bridge.listTools({ projectName: 'owned' });
    const read = tools.find(tool => tool.name === 'mcp__get_project_overview')!;
    const pending = [read.handler({}, ctx()), read.handler({}, ctx())];
    expect(fake.transports).toHaveBeenCalledOnce(); expect(fake.calls).not.toHaveBeenCalled();
    finish();
    expect((await Promise.all(pending)).every(result => result.content === 'owned result')).toBe(true);
    expect(fake.lists).toHaveBeenCalledOnce(); expect(fake.calls).toHaveBeenCalledTimes(2);
    await bridge.close();
  });

  it('rejects schema drift before dispatching a mutation', async () => {
    fake.lists.mockResolvedValue({ tools: [] });
    const bridge = new McpToolBridge({ deferConnection: true });
    const tool = (await bridge.listTools({ projectName: 'owned' })).find(tool => tool.name === 'mcp__index_project')!;
    const result = await tool.handler({ project_path: process.cwd() }, ctx());
    expect(result.isError).toBe(true); expect(result.content).toContain('before dispatch');
    expect(fake.calls).not.toHaveBeenCalled(); expect(fake.closes).toHaveBeenCalledOnce();
    await bridge.close();
  });

  it('cancels a waiter promptly and closes an in-progress handshake with its owner', async () => {
    fake.connects.mockImplementation((_transport, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    const bridge = new McpToolBridge({ deferConnection: true });
    const tool = (await bridge.listTools({ projectName: 'owned' })).find(tool => tool.name === 'mcp__index_project')!;
    const abort = new AbortController();
    const pending = tool.handler({ project_path: process.cwd() }, ctx(abort.signal));
    abort.abort(new Error('stopped'));
    expect((await pending).error).toMatchObject({ code: 'MCP_CALL_CANCELLED', retryable: false });
    expect(fake.calls).not.toHaveBeenCalled();
    await bridge.close(); await expect(bridge.connect()).rejects.toThrow('closed');
    expect(fake.transports).toHaveBeenCalledOnce();
  });
});
