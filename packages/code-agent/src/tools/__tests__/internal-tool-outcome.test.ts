/**
 * Effect contracts of the index tools on the native route: an uncertain or
 * lost confirmation stays uncertain and blocks another mutation, an enforced
 * memory save goes only to its owned port, and reads report transport failures
 * and cancellation. (These cases came from the deleted bridge test,
 * apps/mcp-server/__tests__/mcp-bridge-outcome.test.ts; its access-map case
 * lives in apps/http-api/workers/__tests__/native-index-definitions.test.ts.)
 */
import { describe, expect, it, vi } from 'vitest';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { ToolRegistry } from '../../core/registry.js';
import { ToolCallLedger } from '../../core/tool-call-ledger.js';
import type { ToolContext } from '../../core/tool.js';
import { buildNativeIndexTools, NATIVE_INDEX_PROVENANCE_REF } from '../native-index-tools.js';
import { internalToolDefinition } from '../internal-tool-adapter.js';
import type { IndexToolsPort } from '../../ports/index-tools-port.js';

type Invoke = IndexToolsPort['invoke'];
const db = {} as CodeIndexDB;
const binding = { projectName: 'fixture' };

/**
 * `name` as the native route registers it. index_project and export_docs are
 * never registered; their contract is checked on the same adapter with the
 * same port dispatch.
 */
function nativeTool(name: string, invoke = vi.fn<Invoke>(async () => { throw new Error('ACK lost'); })) {
  const entry = { name, description: name, inputSchema: { type: 'object', properties: {} } };
  const port: IndexToolsPort = { catalog: () => [structuredClone(entry)], invoke };
  const registered = buildNativeIndexTools({ port, db, binding }).find(tool => tool.name === `mcp__${name}`);
  const tool = registered ?? internalToolDefinition(entry, binding, NATIVE_INDEX_PROVENANCE_REF, {
    prepare: async (toolName, signal) => {
      signal?.throwIfAborted();
      return (args, callSignal) => port.invoke(toolName, args, { db, signal: callSignal });
    },
  });
  return { tool, invoke, registered: !!registered };
}

describe('index tool effect contracts (native route)', () => {
  it('preserves uncertainty reported by the owner even when the call completed', async () => {
    const invoke = vi.fn<Invoke>().mockResolvedValue({ content: [{ type: 'text', text: 'Owner lost confirmation' }], isError: true, _meta: { effectOutcome: 'unknown' } });
    const { tool } = nativeTool('index_project', invoke);
    const registry = new ToolRegistry(); registry.register(tool);
    const ctx = { cwd: process.cwd(), toolCallLedger: new ToolCallLedger() } as ToolContext;
    expect(await registry.invoke(tool.name, {}, ctx)).toMatchObject({ effectOutcome: 'unknown', error: { retryable: false } });
    await registry.invoke(tool.name, {}, ctx); expect(invoke).toHaveBeenCalledOnce();
  });

  it('dispatches a repeated read again and returns the new answer instead of replaying the first', async () => {
    const invoke = vi.fn<Invoke>().mockResolvedValueOnce({ content: [{ type: 'text', text: 'src/a.ts' }] })
      .mockResolvedValue({ content: [{ type: 'text', text: 'src/b.ts' }] });
    const { tool, registered } = nativeTool('get_recently_modified_files', invoke);
    expect(registered).toBe(true);
    const registry = new ToolRegistry(); registry.register(tool);
    const ctx = { cwd: process.cwd(), projectName: 'fixture', toolCallLedger: new ToolCallLedger() } as ToolContext;
    expect((await registry.invoke(tool.name, { limit: 1 }, ctx)).content).toContain('src/a.ts');
    expect((await registry.invoke(tool.name, { limit: 1 }, ctx)).content).toContain('src/b.ts');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('routes an enforced save_memory exclusively to its owned port', async () => {
    const { tool, invoke, registered } = nativeTool('save_memory');
    expect(registered).toBe(true);
    const save = vi.fn(async () => ({ created: 1, merged: 0 }));
    const mutationFence = { mode: 'enforce', assertMutation: () => undefined } as unknown as ToolContext['mutationFence'];
    const input = { title: 'Fixture', category: 'decision', content: 'Owned save.' };
    const result = await tool.handler(input, { cwd: process.cwd(), projectName: 'fixture', mutationFence,
      ports: { memoryMutations: { invoke: save } } } as unknown as ToolContext);
    expect(result).toMatchObject({ content: 'Memory "Fixture" saved (created=1 merged=0).' });
    expect(result.isError).toBeFalsy();
    expect(save).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
    expect((await tool.handler(input, { cwd: process.cwd(), mutationFence } as ToolContext)).isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(['save_memory', 'export_docs', 'index_project', 'unknown'])
  ('does not allow a retry after %s loses confirmation', async name => {
    const { tool, invoke } = nativeTool(name);
    const registry = new ToolRegistry();
    registry.register(tool);
    const ledger = new ToolCallLedger();
    const ctx = { cwd: process.cwd(), toolCallLedger: ledger } as ToolContext;
    expect(await registry.invoke(tool.name, {}, ctx)).toMatchObject({
      effectOutcome: 'unknown', error: { code: 'TOOL_OUTCOME_UNKNOWN', retryable: false },
    });
    expect(ledger.outcomeUnknownTool).toBe(tool.name);
    await registry.invoke(tool.name, {}, ctx);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('permits recovery from a transport failure for a reviewed read', async () => {
    const { tool } = nativeTool('read_file');
    const result = await tool.handler({}, { cwd: process.cwd() } as ToolContext);
    expect(result).toMatchObject({ error: { kind: 'network', retryable: true } });
    expect(result.effectOutcome).toBeUndefined();
  });

  it('classifies a cancelled read without suggesting a retry', async () => {
    const controller = new AbortController();
    const { tool } = nativeTool('search', vi.fn<Invoke>(async () => {
      controller.abort(); throw new Error('cancelled');
    }));
    expect(await tool.handler({}, { cwd: process.cwd(), signal: controller.signal } as ToolContext))
      .toMatchObject({ error: { kind: 'cancelled', retryable: false } });
  });

  it('never dispatches or marks an effect uncertain when already cancelled', async () => {
    const { tool, invoke } = nativeTool('save_memory');
    const controller = new AbortController(); controller.abort();
    const result = await tool.handler({}, { cwd: process.cwd(), signal: controller.signal } as ToolContext);
    expect(result).toMatchObject({ error: { kind: 'cancelled', retryable: false } });
    expect(result.effectOutcome).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});
