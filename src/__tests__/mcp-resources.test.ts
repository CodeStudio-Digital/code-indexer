import { describe, it, expect } from 'vitest';
import { buildMcpResourceTools } from '../core/coder/tools/mcp-resources.js';
import type { McpToolBridge } from '../core/coder/tools/mcp-bridge.js';
import type { ToolContext } from '../core/coder/core/tool.js';

const ctx: ToolContext = { cwd: '/tmp', projectName: 'test' };

/**
 * Lightweight bridge stub. We don't connect to a real MCP server — only the
 * surface the resource tools touch (`listResources`, `readResource`) needs to
 * exist.
 */
function makeBridge(stub: {
  resources?: Awaited<ReturnType<McpToolBridge['listResources']>>['resources'];
  templates?: Awaited<ReturnType<McpToolBridge['listResources']>>['templates'];
  readImpl?: (uri: string) => Promise<{ contents: string; mimeType?: string }>;
}): McpToolBridge {
  return {
    listResources: async () => ({
      resources: stub.resources ?? [],
      templates: stub.templates ?? [],
    }),
    readResource: stub.readImpl ?? (async () => ({ contents: 'x' })),
  } as unknown as McpToolBridge;
}

describe('mcp_list_resources', () => {
  it('reports empty when server has none', async () => {
    const [list] = buildMcpResourceTools(makeBridge({}));
    const r = await list.handler({}, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('no resources');
  });

  it('lists resources and templates with mime/desc', async () => {
    const [list] = buildMcpResourceTools(
      makeBridge({
        resources: [
          { uri: 'mcp://skel/foo.ts', name: 'foo skeleton', description: 'TS file outline', mimeType: 'text/plain' },
        ],
        templates: [
          { uriTemplate: 'mcp://skel/{path}', name: 'skeleton-by-path', description: 'fetch skeleton', mimeType: 'text/plain' },
        ],
      }),
    );
    const r = await list.handler({}, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('mcp://skel/foo.ts');
    expect(r.content).toContain('TS file outline');
    expect(r.content).toContain('Resource templates (1)');
    expect(r.content).toContain('mcp://skel/{path}');
  });
});

describe('mcp_read_resource', () => {
  it('returns the resource contents with the URI header', async () => {
    const [, read] = buildMcpResourceTools(
      makeBridge({
        readImpl: async (uri) => ({ contents: `body for ${uri}`, mimeType: 'text/markdown' }),
      }),
    );
    const r = await read.handler({ uri: 'mcp://docs/intro' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('mcp://docs/intro');
    expect(r.content).toContain('text/markdown');
    expect(r.content).toContain('body for mcp://docs/intro');
  });

  it('errors with a hint to call list when read fails', async () => {
    const [, read] = buildMcpResourceTools(
      makeBridge({
        readImpl: async () => { throw new Error('not found'); },
      }),
    );
    const r = await read.handler({ uri: 'mcp://bogus' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('mcp_list_resources');
    expect(r.content).toContain('not found');
  });

  it('rejects empty URI', async () => {
    const [, read] = buildMcpResourceTools(makeBridge({}));
    const r = await read.handler({ uri: '' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('uri cannot be empty');
  });
});
