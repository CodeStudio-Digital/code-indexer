import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { docsTools } from '@mcp/company/tools/docs-tools.js';
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';

function collectArraySchemasMissingItems(schema: unknown, path = '$'): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const node = schema as Record<string, unknown>;
  const missing = node.type === 'array' && !('items' in node) ? [path] : [];

  for (const [key, value] of Object.entries(node)) {
    if (!value || typeof value !== 'object') continue;
    missing.push(...collectArraySchemasMissingItems(value, `${path}.${key}`));
  }

  return missing;
}

describe('docs tools schemas', () => {
  it('declares items for every docs_index_update array schema', () => {
    const tool = docsTools.find((t) => t.name === 'docs_index_update');

    expect(tool).toBeDefined();
    expect(collectArraySchemasMissingItems(tool!.parameters)).toEqual([]);
  });
});

describe('docs_index_update', () => {
  function makeContext(
    writeFile: ISandboxDriver['writeFile'],
  ): ToolContext {
    return {
      cwd: '/tmp',
      projectName: 'test',
      companyContext: {
        orchestrator: {} as never,
        companySessionId: '00000000-0000-4000-8000-000000000001',
        agentRole: 'master',
        agentRunId: null,
        allowedProjectIds: [],
        isMaster: true,
        sandbox: {
          driver: { writeFile } as unknown as ISandboxDriver,
          containerId: 'container-1',
          workdir: '/app',
          previewUrl: 'http://localhost:5173',
          serviceId: 'main',
        },
      },
    };
  }

  it('writes nested docs index entries through the existing handler validation', async () => {
    const tool = docsTools.find((t) => t.name === 'docs_index_update')!;
    const writes: Array<{ containerId: string; absPath: string; data: string; recursive?: boolean }> = [];
    const sections = [
      {
        title: 'Guide',
        path: 'guide.md',
        children: [{ title: 'Install', path: 'guide/install.md' }],
      },
    ];

    const result = await tool.handler(
      { sections },
      makeContext(async (containerId, absPath, data, options) => {
        writes.push({ containerId, absPath, data, recursive: options?.recursive });
      }),
    );

    expect(result.isError).toBeUndefined();
    expect(writes).toEqual([
      {
        containerId: 'container-1',
        absPath: '/app/docs/index.json',
        data: JSON.stringify({ sections }, null, 2),
        recursive: true,
      },
    ]);
  });

  it('rejects unsafe nested docs index paths before writing', async () => {
    const tool = docsTools.find((t) => t.name === 'docs_index_update')!;
    const writes: unknown[] = [];

    const result = await tool.handler(
      {
        sections: [
          {
            title: 'Guide',
            children: [{ title: 'Escape', path: '../escape.md' }],
          },
        ],
      },
      makeContext(async (...args) => {
        writes.push(args);
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("entry.path '../escape.md' is not a safe relative path");
    expect(writes).toEqual([]);
  });
});
