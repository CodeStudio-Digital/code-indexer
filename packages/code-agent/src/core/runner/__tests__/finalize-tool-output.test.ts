/**
 * Fase 2 — reversible tool-output shaping.
 *
 * `capToolContent` is the shared deterministic head-cut (resume + live).
 * `finalizeToolOutput` is the live spill+cap composition: it stores the RAW
 * pre-reduction original so reducer/cap elisions are recoverable via
 * `get_tool_output`, then caps the SHAPED content with an output_id marker.
 *
 * The dispatch test pins the contract that matters for reversibility: finalize
 * receives the RAW content (not the reduced one), runs AFTER the reducer, and
 * threads the `truncated` flag onto the result block (so resume's
 * `normalizeMessageForCache` won't re-cut).
 */
import { describe, it, expect } from 'vitest';
import { capToolContent, finalizeToolOutput } from '../pure-helpers.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import { buildToolMessage, dispatchTools, toToolResultBlock, type DispatchArgs } from '../nodes/executing-dispatch.js';
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';
import { resolveToolOutputPolicy } from '@mcp/code-agent/core/tool-output-policy.js';

describe('capToolContent', () => {
  it('no-ops when content fits the cap', () => {
    expect(capToolContent('short', 100)).toEqual({ content: 'short', truncated: false });
  });

  it('keeps head/tail and marks without exceeding cap', () => {
    const content = 'x'.repeat(500);
    const r = capToolContent(content, 100);
    expect(r.truncated).toBe(true);
    expect(r.originalSize).toBe(500);
    expect(r.content.startsWith('x')).toBe(true);
    expect(r.content.endsWith('x')).toBe(true);
    expect(r.content).toContain('original_size=500');
    expect(r.content.length).toBeLessThanOrEqual(100);
  });

  it('embeds output_id in the marker when provided, omits it otherwise', () => {
    const content = 'y'.repeat(300);
    expect(capToolContent(content, 50, 'deadbeef0001').content).toContain('output_id=deadbeef0001');
    expect(capToolContent(content, 50).content).not.toContain('output_id=');
  });

  it('is deterministic', () => {
    const content = 'z'.repeat(400);
    expect(capToolContent(content, 80, 'abc')).toEqual(capToolContent(content, 80, 'abc'));
  });

  it('preserves code_exec errors and the [return] block', () => {
    const content = [
      'code_exec: 4 tool call(s)',
      '[output]',
      'noise'.repeat(200),
      'Error: final assertion failed',
      '[return]',
      JSON.stringify({ answer: 'important', tail: 'z'.repeat(300) }),
    ].join('\n');
    const result = capToolContent(content, 320, 'exec1234', 'code_exec');
    expect(result.content).toContain('output_id=exec1234');
    expect(result.content).toContain('Error: final assertion failed');
    expect(result.content).toContain('[return]');
    expect(result.content).toContain('important');
    expect(result.content.length).toBeLessThanOrEqual(320);
  });

  it('shares spawn_agent budget across every agent report', () => {
    const content = ['header', ...[1, 2, 3].map((n) =>
      `### Agent ${n}: agent-${n}\n[type=explore reason=completed]\n${String(n).repeat(500)}`,
    )].join('\n\n');
    const result = capToolContent(content, 480, 'agents1234', 'spawn_agent');
    for (const n of [1, 2, 3]) expect(result.content).toContain(`### Agent ${n}:`);
    expect(result.content.length).toBeLessThanOrEqual(480);
  });

  it('respects every positive cap exactly', () => {
    const content = 'head-' + 'x'.repeat(1000) + '-tail';
    for (const cap of [1, 2, 8, 32, 100, 255]) {
      const result = capToolContent(content, cap, 'abcdef');
      expect(result.content.length).toBeLessThanOrEqual(cap);
      expect(capToolContent(content, cap, 'abcdef')).toEqual(result);
    }
  });

  it('never emits orphaned UTF-16 surrogates at a hard-cap boundary', () => {
    const result = capToolContent('😀'.repeat(500), 100, 'abcdef');
    expect(result.content.length).toBeLessThanOrEqual(100);
    expect(result.content).not.toMatch(/[\uD800-\uDFFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });
});

describe('finalizeToolOutput', () => {
  const recorder = () => {
    const calls: string[] = [];
    const store = { put: (c: string) => { calls.push(c); return 'cafe1234'; } };
    return { store, calls };
  };

  it('spills the RAW original and truncates the shaped content over cap', () => {
    const { store, calls } = recorder();
    const raw = 'R'.repeat(1000);
    const shaped = 'S'.repeat(500); // still > cap
    const r = finalizeToolOutput({ rawContent: raw, shapedContent: shaped, isError: false, cap: 100, store });
    expect(calls).toEqual([raw]); // spilled the RAW, not the shaped
    expect(r.truncated).toBe(true);
    expect(r.content).toContain('output_id=cafe1234');
    expect(r.content).toContain('original_size=1000');
    expect(r.content).toContain('shaped_size=500');
    expect(r.originalSize).toBe(1000);
    expect(r.outputId).toBe('cafe1234');
    expect(r.reductionReport.stages?.map((stage) => stage.stage)).toEqual(['spill', 'hard_cap']);
  });

  it('advertises output_id when shaped fits but the reducer dropped rows', () => {
    const { store, calls } = recorder();
    const raw = 'R'.repeat(1000);
    const shaped = 'small reduced body';
    const r = finalizeToolOutput({ rawContent: raw, shapedContent: shaped, isError: false, cap: 500, store });
    expect(calls).toEqual([raw]);
    expect(r.truncated).toBeFalsy();
    expect(r.content.startsWith(shaped)).toBe(true);
    expect(r.content).toContain('get_tool_output("cafe1234")');
  });

  it('reserves room for output_id even when reduced content already fills the cap', () => {
    const { store } = recorder();
    const r = finalizeToolOutput({
      rawContent: 'R'.repeat(1000),
      shapedContent: 'S'.repeat(100),
      isError: false,
      cap: 100,
      store,
    });
    expect(r.content.length).toBeLessThanOrEqual(100);
    expect(r.content).toContain('get_tool_output("cafe1234")');
    expect(r.reductionReport.stages?.at(-1)?.stage).toBe('recovery_marker');
  });

  it('keeps output_store as a lossless fallback for cursor recovery', () => {
    const { store, calls } = recorder();
    const raw = 'R'.repeat(1000);
    const r = finalizeToolOutput({
      toolName: 'read_file',
      rawContent: raw,
      shapedContent: raw,
      isError: false,
      cap: 100,
      store,
      policy: resolveToolOutputPolicy('read_file'),
    });
    expect(calls).toEqual([raw]);
    expect(r.content).toContain('output_id=cafe1234');
  });

  it('uses tool-specific cursor guidance when a store is unavailable', () => {
    const raw = 'R'.repeat(1000);
    const r = finalizeToolOutput({
      toolName: 'read_file',
      rawContent: raw,
      shapedContent: raw,
      isError: false,
      cap: 140,
      policy: resolveToolOutputPolicy('read_file'),
    });
    expect(r.content).toContain('start_line/end_line');
  });

  it('keeps a spill fallback for third-party page tools', () => {
    const { store, calls } = recorder();
    const raw = 'P'.repeat(1000);
    const r = finalizeToolOutput({
      toolName: 'plugin__demo__page',
      rawContent: raw,
      shapedContent: raw,
      isError: false,
      cap: 100,
      store,
      policy: resolveToolOutputPolicy('plugin__demo__page', {
        mode: 'page', reducer: 'none', recovery: 'cursor',
      }),
    });
    expect(calls).toEqual([raw]);
    expect(r.content).toContain('output_id=cafe1234');
  });

  it('does not spill when nothing exceeds the cap and no error', () => {
    const { store, calls } = recorder();
    const r = finalizeToolOutput({ rawContent: 'tiny', shapedContent: 'tiny', isError: false, cap: 100, store });
    expect(calls).toEqual([]);
    expect(r.content).toBe('tiny');
    expect(r.reductionReport).toMatchObject({ kind: 'none', rawChars: 4, shapedChars: 4 });
  });

  it('caps without an output_id when no store is available (subagent/test)', () => {
    const raw = 'R'.repeat(1000);
    const r = finalizeToolOutput({ rawContent: raw, shapedContent: raw, isError: false, cap: 100 });
    expect(r.truncated).toBe(true);
    expect(r.content).not.toContain('output_id=');
  });

  it('spills on error even when small (preserve full trace)', () => {
    const { store, calls } = recorder();
    const err = 'FAILED: boom';
    const r = finalizeToolOutput({ rawContent: err, shapedContent: err, isError: true, cap: 1000, store });
    expect(calls).toEqual([err]);
    expect(r.content).toBe(err); // fits cap, no reduction → returned as-is
  });

  it('records irreversible source caps separately from semantic/final shaping', () => {
    const raw = 'head\n[truncated: 900 bytes omitted; preserved beginning and true tail]\ntail';
    const r = finalizeToolOutput({
      toolName: 'run_command',
      rawContent: raw,
      shapedContent: raw,
      isError: false,
      cap: 1000,
      sourceTruncations: [{
        technique: 'bounded-stream-cap',
        inputSize: 977,
        outputSize: raw.length,
        unit: 'bytes',
        recoverable: false,
      }],
    });
    expect(r.reductionReport.stages).toEqual([
      expect.objectContaining({ stage: 'source_cap', technique: 'bounded-stream-cap', recoverable: false }),
    ]);
    expect(r.reductionReport).toMatchObject({
      kind: 'source_cap',
      technique: 'bounded-stream-cap',
    });
  });

  it('promotes a producer recovery id and never spills its capped preview again', () => {
    let puts = 0;
    const preview = `PREVIEW-${'p'.repeat(300)}`;
    const r = finalizeToolOutput({
      toolName: 'mcp__verbose',
      rawContent: preview,
      shapedContent: preview,
      isError: false,
      cap: 140,
      store: { put: () => { puts += 1; return 'cafe00000009'; } },
      sourceTruncations: [{
        technique: 'mcp-pathological-guard',
        inputSize: 9_000_000,
        outputSize: 1_000,
        unit: 'chars',
        recoverable: true,
        outputId: 'cafe00000008',
      }],
    });

    expect(r.outputId).toBe('cafe00000008');
    expect(r.truncated).toBe(true);
    expect(r.originalSize).toBe(9_000_000);
    expect(r.content).toContain('original_size=9000000');
    expect(r.reductionReport.outputId).toBe('cafe00000008');
    expect(r.reductionReport.stages).toEqual([
      expect.objectContaining({ stage: 'source_cap', technique: 'mcp-pathological-guard' }),
      expect.objectContaining({ stage: 'hard_cap', recoverable: true }),
    ]);
    expect(puts).toBe(0);
  });

  it('does not infer a source cap when a command merely prints a marker', () => {
    const raw = '[truncated: 900 bytes omitted; preserved beginning and true tail]';
    const r = finalizeToolOutput({
      toolName: 'run_command', rawContent: raw, shapedContent: raw, isError: false, cap: 1000,
    });
    expect(r.reductionReport.stages).toEqual([]);
  });

  it('does not create a recovery-of-recovery output for an already paged result', () => {
    const { store, calls } = recorder();
    const page = 'P'.repeat(180);
    const r = finalizeToolOutput({
      toolName: 'get_tool_output',
      rawContent: page,
      shapedContent: page,
      isError: false,
      cap: 100,
      store,
      policy: resolveToolOutputPolicy('get_tool_output'),
    });
    expect(calls).toEqual([]);
    expect(r.outputId).toBeUndefined();
    expect(r.content).not.toContain('output_id=');
    expect(r.reductionReport.preserved).toContain('contiguous_prefix');
    expect(r.reductionReport).toMatchObject({ policyMode: 'page', recovery: 'cursor' });
  });

  it('keeps exact ranges contiguous instead of splicing an unrelated tail', () => {
    const raw = 'HEAD-' + 'middle'.repeat(80) + '-TAIL';
    const r = finalizeToolOutput({
      toolName: 'read_file',
      rawContent: raw,
      shapedContent: raw,
      isError: false,
      cap: 120,
      policy: resolveToolOutputPolicy('read_file'),
    });
    expect(r.content).toContain('HEAD-');
    expect(r.content).not.toContain('-TAIL');
    expect(r.reductionReport.preserved).toContain('contiguous_prefix');
  });
});

// ---- dispatch wiring ----

function registryWith(content: string): ToolRegistry {
  const r = new ToolRegistry();
  const tool: CoderTool = {
    name: 'foo',
    description: 'mock tool',
    parameters: { type: 'object', properties: {} },
    source: 'native',
    handler: async () => ({ content }),
  };
  r.register(tool);
  return r;
}

function registryWithStructuredResult(): ToolRegistry {
  const r = new ToolRegistry();
  r.register({
    name: 'foo',
    description: 'mock structured tool',
    parameters: { type: 'object', properties: {} },
    source: 'native',
    handler: async () => ({
      content: '# Visible\n\nid | status\n--- | ---\na | ready',
      contentFormat: 'markdown',
      structuredData: { id: 'a', status: 'ready', secret: 'hidden-object-only' },
    }),
  });
  return r;
}

const toolContext = { cwd: process.cwd(), projectName: 'test' } as ToolContext;

function baseArgs(registry: ToolRegistry): DispatchArgs {
  return { toolUses: [{ id: 't1', name: 'foo', input: {} }], registry, toolContext, turn: 1, dupCalls: new Map() };
}

describe('dispatchTools — finalize hook', () => {
  it('runs after the reducer, gets RAW + shaped, and threads the truncated flag', async () => {
    let seen: { rawContent: string; shapedContent: string } | null = null;
    let reducerMeta: { input: Record<string, unknown>; isError: boolean; contentFormat: string } | undefined;
    const res = await dispatchTools({
      ...baseArgs(registryWith('RAWBODY')),
      reduceToolResult: (_name, content, meta) => {
        reducerMeta = meta;
        return `${content}-reduced`;
      },
      finalizeToolResult: (a) => {
        seen = { rawContent: a.rawContent, shapedContent: a.shapedContent };
        return { content: 'FINAL', truncated: true, originalSize: 7 };
      },
    });
    expect(seen).toEqual({ rawContent: 'RAWBODY', shapedContent: 'RAWBODY-reduced' });
    expect(reducerMeta).toEqual({ input: {}, isError: false, contentFormat: 'text' });
    expect(res.results[0].content).toBe('FINAL');
    expect(res.results[0].truncated).toBe(true);
    // Measurement fix: the result carries the RAW (pre-reduce) size so index.ts
    // records output_chars=raw and output_chars_shaped=visible (savings ≠ 0).
    expect(res.results[0].rawChars).toBe('RAWBODY'.length);
    const block = toToolResultBlock(res.results[0]) as { truncated?: boolean; originalSize?: number };
    expect(block.truncated).toBe(true);
    expect(block.originalSize).toBe(7);
  });

  it('threads explicit source metadata through dispatch and never infers it from text', async () => {
    const source = {
      technique: 'bounded-stream-cap',
      inputSize: 2_000,
      outputSize: 500,
      unit: 'chars' as const,
      recoverable: false,
    };
    const registry = new ToolRegistry();
    registry.register({
      name: 'foo',
      description: 'mock capped tool',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      handler: async () => ({
        content: '[truncated: this marker is display text]',
        sourceTruncations: [source],
      }),
    });
    let seenSource: unknown;
    const res = await dispatchTools({
      ...baseArgs(registry),
      finalizeToolResult: (args) => {
        seenSource = args.sourceTruncations;
        return finalizeToolOutput({ ...args, cap: 1_000 });
      },
    });

    expect(seenSource).toEqual([source]);
    expect(res.results[0].sourceTruncations).toEqual([source]);
    expect(res.results[0].reductionReport?.stages).toEqual([
      expect.objectContaining({ stage: 'source_cap', technique: 'bounded-stream-cap' }),
    ]);

    const markerOnly = await dispatchTools({
      ...baseArgs(registryWith('[truncated: this marker is only user-visible text]')),
      finalizeToolResult: (args) => finalizeToolOutput({ ...args, cap: 1_000 }),
    });
    expect(markerOnly.results[0].sourceTruncations).toBeUndefined();
    expect(markerOnly.results[0].reductionReport?.stages).toEqual([]);
  });

  it('leaves content unchanged when no finalize hook is wired', async () => {
    const res = await dispatchTools({
      ...baseArgs(registryWith('RAWBODY')),
      reduceToolResult: (_name, content) => `${content}-reduced`,
    });
    expect(res.results[0].content).toBe('RAWBODY-reduced');
    expect(res.results[0].truncated).toBeUndefined();
  });

  it('delivers only content to the provider message and keeps structured data out', async () => {
    const res = await dispatchTools(baseArgs(registryWithStructuredResult()));
    expect(res.results[0]).toMatchObject({
      contentFormat: 'markdown',
      structuredOutputChars: JSON.stringify({ id: 'a', status: 'ready', secret: 'hidden-object-only' }).length,
    });
    expect(res.results[0]).not.toHaveProperty('structuredData');
    const providerMessage = buildToolMessage(res.results);
    expect(JSON.stringify(providerMessage)).toContain('# Visible');
    expect(JSON.stringify(providerMessage)).not.toContain('hidden-object-only');
  });

  it('records early direct refusals in the shared ledger', async () => {
    const context = { ...toolContext, toolCallLedger: new ToolCallLedger() };
    const res = await dispatchTools({
      ...baseArgs(registryWith('never invoked')),
      toolContext: context,
      isToolBlocked: () => 'disabled by session policy',
    });
    expect(res.results[0].ledgerEntry).toMatchObject({
      outcome: 'refusal',
      isError: true,
      refusalKind: 'gate',
    });
  });
});
