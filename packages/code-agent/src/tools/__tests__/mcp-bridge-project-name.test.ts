import { describe, expect, it, vi } from 'vitest';
import type { JsonSchema, ToolContext } from '@mcp/code-agent/core/tool.js';
import { McpToolBridge, stripInjectedProjectName } from '../mcp-bridge.js';

describe('McpToolBridge project_name injection', () => {
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
});
