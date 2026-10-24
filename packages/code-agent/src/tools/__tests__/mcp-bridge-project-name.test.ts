import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonSchema, ToolContext } from '@mcp/code-agent/core/tool.js';
import { SessionOverlay } from '@mcp/code-agent/overlay/session-overlay.js';
import {
  guardPathologicalMcpOutput,
  McpToolBridge,
  stripInjectedProjectName,
} from '../mcp-bridge.js';

describe('McpToolBridge project_name injection', () => {
  it('declares only reviewed internal reads parallel-safe and cancels the MCP request', async () => {
    const controller = new AbortController();
    const callTool = vi.fn(async (_request, _schema, options) => {
      expect(options.signal).toBe(controller.signal);
      return { content: [{ type: 'text', text: 'found' }] };
    });
    const fakeClient = {
      listTools: async () => ({ tools: ['grep_code', 'search', 'unknown'].map(name => ({ name,
        inputSchema: { type: 'object', properties: {} } })) }), callTool,
    };
    const bridge = new McpToolBridge();
    (bridge as unknown as { client: typeof fakeClient }).client = fakeClient;
    const tools = await bridge.listTools({ projectName: 'owned' });
    for (const tool of tools.slice(0, 2)) expect(tool).toMatchObject({ mutates: false, parallelSafe: true, riskLevel: 'read' });
    expect(tools[2]).toMatchObject({ mutates: true, parallelSafe: false, riskLevel: 'write' });
    const context = { cwd: '/tmp/owned', signal: controller.signal } as ToolContext;
    expect((await tools[0]!.handler({ pattern: 'needle' }, context)).content).toBe('found');
    controller.abort();
    expect((await tools[0]!.handler({ pattern: 'needle' }, context)).isError).toBe(true);
    expect(callTool).toHaveBeenCalledOnce();
  });
  it('hides project_name from the public schema without mutating the server schema', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        project_name: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['project_name', 'query'],
      additionalProperties: false,
    };

    const publicSchema = stripInjectedProjectName(schema) as {
      properties: Record<string, unknown>;
      required?: string[];
    };

    expect(publicSchema.properties).not.toHaveProperty('project_name');
    expect(publicSchema.properties).toHaveProperty('query');
    expect(publicSchema.required).toEqual(['query']);
    expect(schema.properties).toHaveProperty('project_name');
    expect(schema.required).toEqual(['project_name', 'query']);
  });

  it('overwrites any caller-supplied project_name with the bridge project', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
    const fakeClient = {
      listTools: vi.fn(async () => ({
        tools: [{
          name: 'search',
          description: 'search code',
          inputSchema: {
            type: 'object',
            properties: {
              project_name: { type: 'string' },
              query: { type: 'string' },
            },
            required: ['project_name', 'query'],
            additionalProperties: false,
          },
        }],
      })),
      callTool,
    };

    const bridge = new McpToolBridge();
    (bridge as unknown as { client: typeof fakeClient }).client = fakeClient;

    const [tool] = await bridge.listTools({ projectName: '__global_abc' });
    expect((tool.parameters as { properties: Record<string, unknown> }).properties).not.toHaveProperty('project_name');
    expect((tool.parameters as { required?: string[] }).required).toEqual(['query']);

    const result = await tool.handler(
      { project_name: 'project', query: 'RecurringChargeResource' },
      { cwd: '/tmp/global', projectName: 'visible-label' } as ToolContext,
    );

    expect(result.isError).toBeFalsy();
    expect(callTool).toHaveBeenCalledWith({
      name: 'search',
      arguments: {
        query: 'RecurringChargeResource',
        project_name: '__global_abc',
      },
    });
  });

  it('returns oversized MCP text intact so the runner can spill the raw value', async () => {
    const payload = `${'x'.repeat(220_000)}TAIL_SENTINEL`;
    const fakeClient = {
      listTools: vi.fn(async () => ({
        tools: [{
          name: 'verbose',
          description: 'verbose result',
          inputSchema: { type: 'object', properties: {} },
        }],
      })),
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: payload }] })),
    };
    const bridge = new McpToolBridge();
    (bridge as unknown as { client: typeof fakeClient }).client = fakeClient;

    const [tool] = await bridge.listTools({ projectName: 'project' });
    const result = await tool.handler({}, { cwd: '/tmp/project' } as ToolContext);

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(payload);
    expect(result.content).toContain('TAIL_SENTINEL');
  });

  it('clamps max_lines without claiming source omission', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'page' }] }));
    const fakeClient = {
      listTools: vi.fn(async () => ({
        tools: [{
          name: 'read_file',
          description: 'read a file',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' }, max_lines: { type: 'number' } },
          },
        }],
      })),
      callTool,
    };
    const bridge = new McpToolBridge();
    (bridge as unknown as { client: typeof fakeClient }).client = fakeClient;

    const [tool] = await bridge.listTools({ projectName: 'project' });
    const result = await tool.handler(
      { path: 'src/index.ts', max_lines: 5_000 },
      { cwd: '/tmp/project', projectName: 'project' } as ToolContext,
    );

    expect(callTool).toHaveBeenCalledWith({
      name: 'read_file',
      arguments: { path: 'src/index.ts', max_lines: 800 },
    });
    // Argument clamping alone does not prove that this small source omitted
    // any lines. The note remains visible, but telemetry stays truthful.
    expect(result.content).toContain('[note: max_lines clamped from 5000 to 800 by bridge]');
    expect(result.content).not.toContain('[truncated:');
    expect(result.sourceTruncations).toBeUndefined();
  });

  it('imports MCP omission metadata but rejects a remote output store id', async () => {
    const fakeClient = {
      listTools: vi.fn(async () => ({
        tools: [{
          name: 'read_file',
          description: 'read a file',
          inputSchema: { type: 'object', properties: {} },
        }],
      })),
      callTool: vi.fn(async () => ({
        content: [{ type: 'text', text: 'lines 401-800' }],
        _meta: {
          sourceTruncations: [{
            technique: 'mcp-read-file-line-window',
            inputSize: 1_000,
            inputSizeExact: false,
            outputSize: 400,
            unit: 'lines',
            recoverable: true,
            // MCP servers cannot mint ids in this process's ToolOutputStore.
            outputId: 'deadbeef',
          }],
        },
      })),
    };
    const bridge = new McpToolBridge();
    (bridge as unknown as { client: typeof fakeClient }).client = fakeClient;

    const [tool] = await bridge.listTools({ projectName: 'project' });
    const result = await tool.handler({}, { cwd: '/tmp/project' } as ToolContext);

    expect(result.content).toBe('lines 401-800');
    expect(result.sourceTruncations).toEqual([{
      technique: 'mcp-read-file-line-window',
      inputSize: 1_000,
      inputSizeExact: false,
      outputSize: 400,
      unit: 'lines',
      recoverable: true,
    }]);
  });

  it('applies the same line clamp and records real dirty-overlay omission', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-overlay-clamp-'));
    try {
      writeFileSync(
        join(root, 'dirty.ts'),
        Array.from({ length: 1_000 }, (_, index) => `row ${index + 1}`).join('\n'),
      );
      const overlay = new SessionOverlay(root);
      overlay.mark('dirty.ts');
      const callTool = vi.fn();
      const fakeClient = {
        listTools: vi.fn(async () => ({
          tools: [{
            name: 'read_file',
            description: 'read a file',
            inputSchema: {
              type: 'object',
              properties: {
                file_path: { type: 'string' },
                max_lines: { type: 'number' },
              },
            },
          }],
        })),
        callTool,
      };
      const bridge = new McpToolBridge();
      (bridge as unknown as { client: typeof fakeClient }).client = fakeClient;

      const [tool] = await bridge.listTools({ projectName: 'project', overlay });
      const result = await tool.handler(
        { file_path: 'dirty.ts', max_lines: 5_000 },
        { cwd: root, projectName: 'project', overlay } as ToolContext,
      );

      expect(callTool).not.toHaveBeenCalled();
      expect(result.content).toContain('max_lines clamped from 5000 to 800');
      expect(result.content).toContain('row 800');
      expect(result.content).not.toContain('row 801');
      expect(result.sourceTruncations?.map((source) => source.technique)).toEqual([
        'overlay-read-file-line-window',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MCP pathological output guard', () => {
  it('stores the exact payload before applying the runner-sized emergency cap', () => {
    const raw = `BEGIN-${'x'.repeat(4_000)}-TAIL`;
    const puts: string[] = [];
    const ctx = {
      cwd: process.cwd(),
      projectName: 'test',
      toolOutputInlineCap: 500,
      toolOutputStore: {
        put: (content: string) => { puts.push(content); return 'mcpfull123'; },
      },
    } as unknown as ToolContext;

    const guarded = guardPathologicalMcpOutput(raw, ctx, 2_000);
    expect(puts).toEqual([raw]);
    expect(guarded.length).toBeLessThanOrEqual(500);
    expect(guarded).toContain('output_id=mcpfull123');
    expect(guarded).toContain(`original_size=${raw.length}`);
  });
});
