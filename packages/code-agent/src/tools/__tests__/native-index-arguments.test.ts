/**
 * What the shared adapter sends to the index tools and hands back on the
 * native route: contract flags, the bound project, the public schema, raw
 * output kept for the runner's spill, the read_file line clamp and imported
 * omission metadata. (These cases came from the deleted bridge test,
 * mcp-bridge-project-name.test.ts.)
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { JsonSchema, ToolContext } from '@mcp/code-agent/core/tool.js';
import { SessionOverlay } from '@mcp/code-agent/overlay/session-overlay.js';
import { buildNativeIndexTools } from '../native-index-tools.js';
import { stripInjectedProjectName } from '../internal-tool-schema.js';
import { guardPathologicalMcpOutput } from '../mcp-output-guard.js';
import type { InternalToolBinding } from '../internal-tool-adapter.js';
import type { IndexToolCatalogEntry, IndexToolsPort } from '../../ports/index-tools-port.js';

const db = {} as CodeIndexDB;
type Invoke = IndexToolsPort['invoke'];
const entry = (name: string, inputSchema: Record<string, unknown> = { type: 'object', properties: {} }): IndexToolCatalogEntry =>
  ({ name, description: name, inputSchema });
/** The index tool `name` as the native route registers it for `binding`. */
function nativeTool(name: string, catalog: IndexToolCatalogEntry[], invoke: Invoke, binding: InternalToolBinding = { projectName: 'project' }) {
  return buildNativeIndexTools({ port: { catalog: () => structuredClone(catalog), invoke }, db, binding })
    .find(tool => tool.name === `mcp__${name}`)!;
}
const text = (value: string) => ({ content: [{ type: 'text', text: value }] });

describe('native index tools: arguments and output', () => {
  it('declares only reviewed internal reads parallel-safe and cancels the call', async () => {
    const controller = new AbortController();
    const invoke = vi.fn<Invoke>(async (_name, _args, ctx) => {
      expect(ctx.signal).toBe(controller.signal);
      return text('found');
    });
    const catalog = ['grep_code', 'search', 'unknown'].map(name => entry(name));
    for (const name of ['grep_code', 'search']) {
      expect(nativeTool(name, catalog, invoke, { projectName: 'owned' })).toMatchObject({ mutates: false, parallelSafe: true, riskLevel: 'read' });
    }
    expect(nativeTool('unknown', catalog, invoke)).toMatchObject({ mutates: true, parallelSafe: false, riskLevel: 'write' });
    const grep = nativeTool('grep_code', catalog, invoke, { projectName: 'owned' });
    const context = { cwd: '/tmp/owned', signal: controller.signal } as ToolContext;
    expect((await grep.handler({ pattern: 'needle' }, context)).content).toBe('found');
    controller.abort();
    expect((await grep.handler({ pattern: 'needle' }, context)).isError).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('hides project_name from the public schema without mutating the published schema', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { project_name: { type: 'string' }, query: { type: 'string' } },
      required: ['project_name', 'query'],
      additionalProperties: false,
    };
    const publicSchema = stripInjectedProjectName(schema) as { properties: Record<string, unknown>; required?: string[] };
    expect(publicSchema.properties).not.toHaveProperty('project_name');
    expect(publicSchema.properties).toHaveProperty('query');
    expect(publicSchema.required).toEqual(['query']);
    expect(schema.properties).toHaveProperty('project_name');
    expect(schema.required).toEqual(['project_name', 'query']);
  });

  it('overwrites any caller-supplied project_name with the bound project', async () => {
    const invoke = vi.fn<Invoke>(async () => text('ok'));
    const tool = nativeTool('search', [entry('search', {
      type: 'object',
      properties: { project_name: { type: 'string' }, query: { type: 'string' } },
      required: ['project_name', 'query'],
      additionalProperties: false,
    })], invoke, { projectName: '__global_abc' });
    expect((tool.parameters as { properties: Record<string, unknown> }).properties).not.toHaveProperty('project_name');
    expect((tool.parameters as { required?: string[] }).required).toEqual(['query']);
    const result = await tool.handler({ project_name: 'project', query: 'RecurringChargeResource' },
      { cwd: '/tmp/global', projectName: 'visible-label' } as ToolContext);
    expect(result.isError).toBeFalsy();
    expect(invoke).toHaveBeenCalledWith('search', { query: 'RecurringChargeResource', project_name: '__global_abc' }, { db, signal: undefined });
  });

  it('returns oversized text intact so the runner can spill the raw value', async () => {
    const payload = `${'x'.repeat(220_000)}TAIL_SENTINEL`;
    const tool = nativeTool('verbose', [entry('verbose')], vi.fn<Invoke>(async () => text(payload)));
    const result = await tool.handler({}, { cwd: '/tmp/project' } as ToolContext);
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
    expect(result.content).toContain('TAIL_SENTINEL');
  });

  it('clamps max_lines without claiming source omission', async () => {
    const invoke = vi.fn<Invoke>(async () => text('page'));
    const tool = nativeTool('read_file', [entry('read_file', { type: 'object', properties: { path: { type: 'string' }, max_lines: { type: 'number' } } })], invoke);
    const result = await tool.handler({ path: 'src/index.ts', max_lines: 5_000 }, { cwd: '/tmp/project', projectName: 'project' } as ToolContext);
    expect(invoke).toHaveBeenCalledWith('read_file', { path: 'src/index.ts', max_lines: 800 }, { db, signal: undefined });
    // Argument clamping alone does not prove that this small source omitted
    // any lines. The note remains visible, but telemetry stays truthful.
    expect(result.content).toContain('[note: max_lines clamped from 5000 to 800 by bridge]');
    expect(result.content).not.toContain('[truncated:');
    expect(result.sourceTruncations).toBeUndefined();
  });

  it('imports omission metadata but rejects an output store id it did not mint', async () => {
    const tool = nativeTool('read_file', [entry('read_file')], vi.fn<Invoke>(async () => ({
      ...text('lines 401-800'),
      _meta: { sourceTruncations: [{ technique: 'mcp-read-file-line-window', inputSize: 1_000, inputSizeExact: false,
        outputSize: 400, unit: 'lines', recoverable: true,
        // Only this process's ToolOutputStore mints ids.
        outputId: 'deadbeef' }] },
    })));
    const result = await tool.handler({}, { cwd: '/tmp/project' } as ToolContext);
    expect(result.content).toBe('lines 401-800');
    expect(result.sourceTruncations).toEqual([{ technique: 'mcp-read-file-line-window', inputSize: 1_000, inputSizeExact: false,
      outputSize: 400, unit: 'lines', recoverable: false }]);
  });

  it('applies the same line clamp to a dirty file, which reads through the index tool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-overlay-clamp-'));
    try {
      writeFileSync(join(root, 'dirty.ts'), Array.from({ length: 1_000 }, (_, index) => `row ${index + 1}`).join('\n'));
      const overlay = new SessionOverlay(root);
      overlay.mark('dirty.ts');
      // The index tool reads current disk bytes; it reports its own omission.
      const invoke = vi.fn<Invoke>(async () => ({
        ...text(Array.from({ length: 800 }, (_, index) => `row ${index + 1}`).join('\n')),
        _meta: { sourceTruncations: [{ technique: 'mcp-read-file-line-window', inputSize: 1_000, outputSize: 800, unit: 'lines', recoverable: true }] },
      }));
      const tool = nativeTool('read_file', [entry('read_file', { type: 'object', properties: { file_path: { type: 'string' }, max_lines: { type: 'number' } } })],
        invoke, { projectName: 'project', overlay });
      const result = await tool.handler({ file_path: 'dirty.ts', max_lines: 5_000 }, { cwd: root, projectName: 'project', overlay } as ToolContext);
      expect(invoke).toHaveBeenCalledOnce();
      expect(invoke.mock.calls[0]).toEqual(['read_file', { file_path: 'dirty.ts', max_lines: 800 }, { db, signal: undefined }]);
      expect(result.content).toContain('max_lines clamped from 5000 to 800');
      expect(result.content).toContain('row 800');
      expect(result.content).not.toContain('row 801');
      expect(result.sourceTruncations?.map(source => source.technique)).toEqual(['mcp-read-file-line-window']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('index tool pathological output guard', () => {
  it('stores the exact payload before applying the runner-sized emergency cap', () => {
    const raw = `BEGIN-${'x'.repeat(4_000)}-TAIL`;
    const puts: string[] = [];
    const ctx = {
      cwd: process.cwd(),
      projectName: 'test',
      toolOutputInlineCap: 500,
      toolOutputStore: { put: (content: string) => { puts.push(content); return 'mcpfull123'; } },
    } as unknown as ToolContext;
    const guarded = guardPathologicalMcpOutput(raw, ctx, 2_000);
    expect(puts).toEqual([raw]);
    expect(guarded.length).toBeLessThanOrEqual(500);
    expect(guarded).toContain('output_id=mcpfull123');
    expect(guarded).toContain(`original_size=${raw.length}`);
  });
});
