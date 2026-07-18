import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import {
  setGlobalAgentLspBackend,
  type AgentLspLocation,
} from '@mcp/code-agent/lsp/agent-lsp-backend.js';
import { lspTools } from '../lsp.js';

const referencesTool = lspTools.find((tool) => tool.name === 'lsp_references')!;

describe('lsp_references multi-language backend', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lsp-backend-locations-'));
    writeFileSync(join(root, 'sample.py'), 'target = 1\n');
  });

  afterEach(() => {
    setGlobalAgentLspBackend(null);
    rmSync(root, { recursive: true, force: true });
  });

  it('preserves every backend location when more than 50 are returned', async () => {
    const locations: AgentLspLocation[] = Array.from({ length: 75 }, (_, index) => ({
      file: join(root, 'references', `ref-${index + 1}.py`),
      range: {
        start: { line: index + 1, column: index + 2 },
        end: { line: index + 1, column: index + 3 },
      },
    }));
    setGlobalAgentLspBackend({
      definition: async () => null,
      references: async () => locations,
      hover: async () => null,
    });

    const result = await referencesTool.handler(
      { file_path: 'sample.py', line: 1, column: 1 },
      { cwd: root, projectName: 'lsp-test' } as ToolContext,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Found 75 reference(s):');
    const renderedLocations = result.content
      .split('\n')
      .filter((line) => line.startsWith('  '));
    expect(renderedLocations).toEqual(
      locations.map((location) => (
        `  ${location.file}:${location.range.start.line}:${location.range.start.column}`
      )),
    );
  });
});
