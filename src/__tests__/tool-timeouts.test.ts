import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';

/**
 * Policy tests for `resolveToolTimeoutMs` and `resolveHeartbeatIntervalMs`.
 *
 * The module reads its NORMAL/SLOW constants at module load time, so the
 * env-override tests use `vi.resetModules()` + dynamic import to pick up
 * a fresh module under each env scenario. The heartbeat resolver re-reads
 * env on every call, so it's tested without re-import.
 */

const ENV_KEYS = [
  'MCP_TOOL_NORMAL_TIMEOUT_MS',
  'MCP_TOOL_SLOW_TIMEOUT_MS',
  'MCP_TOOL_HEARTBEAT_MS',
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function makeTool(over: Partial<CoderTool>): CoderTool {
  return {
    name: 'sample',
    description: '',
    parameters: { type: 'object', properties: {} },
    source: 'native',
    handler: async () => ({ content: 'ok' }),
    ...over,
  };
}

describe('resolveToolTimeoutMs — classification', () => {
  beforeEach(() => {
    clearEnv();
    vi.resetModules();
  });
  afterEach(() => {
    clearEnv();
    vi.unstubAllEnvs();
  });

  it('honors explicit tool.timeoutMs over every classifier', async () => {
    const { resolveToolTimeoutMs } = await import('@mcp/code-agent/core/tool-timeouts.js');
    expect(resolveToolTimeoutMs(makeTool({ name: 'docs_deep_research', timeoutMs: 1_234 }))).toBe(1_234);
    expect(resolveToolTimeoutMs(makeTool({ name: 'read_file', timeoutMs: 7_777 }))).toBe(7_777);
  });

  it('returns Infinity for interactive tools (submit_plan / ask_user style)', async () => {
    const { resolveToolTimeoutMs } = await import('@mcp/code-agent/core/tool-timeouts.js');
    expect(resolveToolTimeoutMs(makeTool({ name: 'submit_plan', interactive: true }))).toBe(Infinity);
    expect(resolveToolTimeoutMs(makeTool({ name: 'ask_user', interactive: true }))).toBe(Infinity);
  });

  it('keeps repeatable wait/poll tools bounded without an explicit opt-out', async () => {
    const { resolveToolTimeoutMs } = await import('@mcp/code-agent/core/tool-timeouts.js');
    expect(resolveToolTimeoutMs(makeTool({ name: 'wait_for_compile_clean', repeatable: true }))).toBe(5 * 60_000);
  });

  it('classifies known slow native tools as SLOW (30 min default)', async () => {
    const { resolveToolTimeoutMs, SLOW_TIMEOUT_MS } = await import('@mcp/code-agent/core/tool-timeouts.js');
    for (const name of ['docs_deep_research', 'implement_subagent', 'review_subagent', 'code_exec']) {
      expect(resolveToolTimeoutMs(makeTool({ name }))).toBe(SLOW_TIMEOUT_MS);
    }
    expect(SLOW_TIMEOUT_MS).toBe(30 * 60_000);
  });

  it('classifies rag_/docs_/search_ name-prefix tools as SLOW (vector search)', async () => {
    const { resolveToolTimeoutMs, SLOW_TIMEOUT_MS } = await import('@mcp/code-agent/core/tool-timeouts.js');
    expect(resolveToolTimeoutMs(makeTool({ name: 'rag_search_docs' }))).toBe(SLOW_TIMEOUT_MS);
    expect(resolveToolTimeoutMs(makeTool({ name: 'docs_list_sources' }))).toBe(SLOW_TIMEOUT_MS);
    expect(resolveToolTimeoutMs(makeTool({ name: 'search_codebase' }))).toBe(SLOW_TIMEOUT_MS);
  });

  it('classifies mcp__research* as SLOW', async () => {
    const { resolveToolTimeoutMs, SLOW_TIMEOUT_MS } = await import('@mcp/code-agent/core/tool-timeouts.js');
    expect(resolveToolTimeoutMs(makeTool({ name: 'mcp__research_web' }))).toBe(SLOW_TIMEOUT_MS);
  });

  it('classifies any MCP tool as SLOW — latency is unknown (DB / external API)', async () => {
    const { resolveToolTimeoutMs, SLOW_TIMEOUT_MS } = await import('@mcp/code-agent/core/tool-timeouts.js');
    expect(resolveToolTimeoutMs(makeTool({ name: 'mcp__github__list_issues', source: 'mcp' }))).toBe(SLOW_TIMEOUT_MS);
    expect(resolveToolTimeoutMs(makeTool({ name: 'mcp__custom__do_thing', source: 'mcp_external' }))).toBe(SLOW_TIMEOUT_MS);
  });

  it('falls through to NORMAL for fast native tools (5 min default)', async () => {
    const { resolveToolTimeoutMs, NORMAL_TIMEOUT_MS } = await import('@mcp/code-agent/core/tool-timeouts.js');
    for (const name of ['read_file', 'grep', 'glob', 'write_file', 'edit_file', 'apply_patch']) {
      expect(resolveToolTimeoutMs(makeTool({ name }))).toBe(NORMAL_TIMEOUT_MS);
    }
    expect(NORMAL_TIMEOUT_MS).toBe(5 * 60_000);
  });

  it('honors Infinity as explicit opt-out via timeoutMs', async () => {
    const { resolveToolTimeoutMs } = await import('@mcp/code-agent/core/tool-timeouts.js');
    expect(resolveToolTimeoutMs(makeTool({ name: 'read_file', timeoutMs: Infinity }))).toBe(Infinity);
  });
});

describe('resolveToolTimeoutMs — env overrides', () => {
  beforeEach(() => {
    clearEnv();
    vi.resetModules();
  });
  afterEach(() => {
    clearEnv();
  });

  it('keeps product timeouts unchanged by retired environment switches', async () => {
    process.env.MCP_TOOL_NORMAL_TIMEOUT_MS = '99';
    process.env.MCP_TOOL_SLOW_TIMEOUT_MS = '777';
    const { resolveToolTimeoutMs, NORMAL_TIMEOUT_MS, SLOW_TIMEOUT_MS } = await import(
      '@mcp/code-agent/core/tool-timeouts.js'
    );
    expect(NORMAL_TIMEOUT_MS).toBe(5 * 60_000);
    expect(SLOW_TIMEOUT_MS).toBe(30 * 60_000);
    expect(resolveToolTimeoutMs(makeTool({ name: 'read_file' }))).toBe(5 * 60_000);
    expect(resolveToolTimeoutMs(makeTool({ name: 'docs_deep_research' }))).toBe(30 * 60_000);
  });

  it('ignores invalid values for retired timeout switches', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.MCP_TOOL_NORMAL_TIMEOUT_MS = 'not-a-number';
    process.env.MCP_TOOL_SLOW_TIMEOUT_MS = '-5';
    const { NORMAL_TIMEOUT_MS, SLOW_TIMEOUT_MS } = await import('@mcp/code-agent/core/tool-timeouts.js');
    expect(NORMAL_TIMEOUT_MS).toBe(5 * 60_000);
    expect(SLOW_TIMEOUT_MS).toBe(30 * 60_000);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('resolveHeartbeatIntervalMs', () => {
  beforeEach(() => {
    clearEnv();
  });
  afterEach(() => {
    clearEnv();
  });

  it('returns the 5000 default when no env is set', async () => {
    const { resolveHeartbeatIntervalMs } = await import('@mcp/code-agent/core/tool-timeouts.js');
    expect(resolveHeartbeatIntervalMs()).toBe(5_000);
  });

  it('keeps the fixed heartbeat interval despite retired overrides', async () => {
    const { resolveHeartbeatIntervalMs } = await import('@mcp/code-agent/core/tool-timeouts.js');
    process.env.MCP_TOOL_HEARTBEAT_MS = '1234';
    expect(resolveHeartbeatIntervalMs()).toBe(5_000);
    process.env.MCP_TOOL_HEARTBEAT_MS = '0';
    expect(resolveHeartbeatIntervalMs()).toBe(5_000);
  });

  it('falls back to default on invalid input', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { resolveHeartbeatIntervalMs } = await import('@mcp/code-agent/core/tool-timeouts.js');
    process.env.MCP_TOOL_HEARTBEAT_MS = 'oops';
    expect(resolveHeartbeatIntervalMs()).toBe(5_000);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
