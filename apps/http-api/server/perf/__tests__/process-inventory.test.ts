import { describe, it, expect, vi, beforeEach } from 'vitest';

const ptyEntries = vi.fn<() => Array<{ id: string; pid: number; meta?: unknown }>>(() => []);
const trackedTrees = vi.fn<() => number[]>(() => []);
const localManager = vi.fn<() => { listAll: () => unknown[] } | null>(() => null);
const mcpPool = vi.fn<() => { listStdioProcesses: () => unknown[] } | null>(() => null);

vi.mock('@mcp/api-handlers', () => ({
  sharedPtyManager: { listEntries: () => ptyEntries() },
}));
vi.mock('@mcp/shared/utils/process-tree.js', () => ({
  listTrackedProcessTrees: () => trackedTrees(),
}));
vi.mock('@mcp/services/sandbox/local-process/LocalProcessManager.js', () => ({
  tryGetLocalProcessManager: () => localManager(),
}));
vi.mock('../../../sse/McpExternalPool.js', () => ({
  getGlobalMcpExternalPool: () => mcpPool(),
}));

const { collectProcessInventory } = await import('../process-inventory.js');

beforeEach(() => {
  ptyEntries.mockReturnValue([]);
  trackedTrees.mockReturnValue([]);
  localManager.mockReturnValue(null);
  mcpPool.mockReturnValue(null);
});

describe('collectProcessInventory', () => {
  it('labels terminals and runners from the PTY registry', () => {
    ptyEntries.mockReturnValue([
      { id: 'term-1', pid: 100, meta: { label: 'Terminal: app', cwd: 'D:/app', kind: 'terminal' } },
      { id: 'run-1', pid: 200, meta: { label: 'app: dev', cwd: 'D:/app', kind: 'runner' } },
    ]);
    const { labels, ownedPids } = collectProcessInventory();
    expect(labels.get(100)).toMatchObject({ kind: 'terminal', label: 'Terminal: app', ownerId: 'term-1' });
    expect(labels.get(200)).toMatchObject({ kind: 'runner', ownerKind: 'pty' });
    expect(ownedPids).toEqual([100, 200]);
  });

  it('includes dev servers and stdio MCP servers', () => {
    localManager.mockReturnValue({
      listAll: () => [{ sessionId: 's1', pid: 300, program: 'node', cwd: 'D:/x' }],
    });
    mcpPool.mockReturnValue({
      listStdioProcesses: () => [{ serverId: 'gh', name: 'github', pid: 400 }],
    });
    const { labels } = collectProcessInventory();
    expect(labels.get(300)).toMatchObject({ kind: 'devserver', ownerKind: 'local-process' });
    expect(labels.get(400)).toMatchObject({ kind: 'mcp', label: 'MCP: github' });
  });

  it('counts tracked trees as owned even though they carry no label', () => {
    trackedTrees.mockReturnValue([900, 901]);
    const { labels, ownedPids } = collectProcessInventory();
    expect(labels.size).toBe(0);
    expect(ownedPids).toEqual([900, 901]);
  });

  it('merges the injected Electron source without overriding richer labels', () => {
    ptyEntries.mockReturnValue([
      { id: 'term-1', pid: 100, meta: { label: 'Terminal: app', kind: 'terminal' } },
    ]);
    const { labels, ownedPids } = collectProcessInventory(() => [
      { pid: 100, kind: 'terminal', label: 'terminal:host' },
      { pid: 500, kind: 'helper', label: 'dev-http' },
    ]);
    expect(labels.get(100)?.label).toBe('Terminal: app');
    expect(labels.get(500)?.label).toBe('dev-http');
    expect(ownedPids).toEqual([100, 500]);
  });

  it('survives a registry that throws', () => {
    ptyEntries.mockImplementation(() => {
      throw new Error('pty registry exploded');
    });
    mcpPool.mockReturnValue({
      listStdioProcesses: () => [{ serverId: 'gh', name: 'github', pid: 400 }],
    });
    trackedTrees.mockReturnValue([900]);
    const { labels, ownedPids } = collectProcessInventory();
    expect(labels.get(400)).toBeDefined();
    expect(ownedPids).toEqual([400, 900]);
  });

  it('drops invalid pids', () => {
    ptyEntries.mockReturnValue([
      { id: 'a', pid: 0, meta: { label: 'zero', kind: 'terminal' } },
      { id: 'b', pid: -3, meta: { label: 'negative', kind: 'terminal' } },
    ]);
    trackedTrees.mockReturnValue([0, 5]);
    const { labels, ownedPids } = collectProcessInventory();
    expect(labels.size).toBe(0);
    expect(ownedPids).toEqual([5]);
  });
});
