import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { fileTools } from '@apps/mcp-server/tools/file.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

/**
 * Feature parity between native read_file (src/core/coder/tools/fs.ts) and
 * MCP read_file. The native public schema was deliberately narrowed by the
 * tool-surface audit; MCP compatibility retains additional smart selectors.
 */

const nativeReadFile = fsTools.find((t) => t.name === 'read_file')!;
const mcpReadFile = fileTools.find((t) => t.name === 'read_file')!;

const SAMPLE_FILE = [
  'import { Foo } from "./foo";',
  '',
  'export function helperOne(x: number): number {',
  '  return x + 1;',
  '}',
  '',
  'export function targetSymbol(name: string): string {',
  '  const greeting = `Hello, ${name}!`;',
  '  return greeting.toUpperCase();',
  '}',
  '',
  'export class Container {',
  '  items: string[] = [];',
  '  add(item: string): void {',
  '    this.items.push(item);',
  '  }',
  '}',
  '',
].join('\n');

describe('read_file feature parity (native ↔ MCP)', () => {
  let workDir: string;
  let db: CodeIndexDB;
  const filePath = 'src/sample.ts';

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'rf-parity-'));
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(join(workDir, filePath), SAMPLE_FILE);
    const dbPath = join(workDir, 'index.sqlite');
    db = new CodeIndexDB(dbPath);
    db.createProject('parity-proj', workDir);
  });

  afterAll(() => {
    db.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  function nativeCtx(): ToolContext {
    return { cwd: workDir, projectName: 'parity-proj' };
  }
  function mcpCtx(): Parameters<typeof mcpReadFile.handler>[1] {
    return { db } as unknown as Parameters<typeof mcpReadFile.handler>[1];
  }

  describe('schemas preserve shared selectors and the audited native surface', () => {
    it('shares symbol, force and line ranges while retaining MCP compatibility selectors', () => {
      const nativeProps = (nativeReadFile.parameters as { properties: Record<string, unknown> }).properties;
      const mcpProps = (mcpReadFile.inputSchema as { properties: Record<string, unknown> }).properties;
      for (const key of ['symbol', 'force', 'start_line', 'end_line']) {
        expect(nativeProps).toHaveProperty(key);
        expect(mcpProps).toHaveProperty(key);
      }
      for (const key of ['around_line', 'search_term', 'max_lines']) {
        expect(nativeProps).not.toHaveProperty(key);
        expect(mcpProps).toHaveProperty(key);
      }
    });

    it('neither schema exposes the auto_full opt-out (now env-only)', () => {
      const nativeProps = (nativeReadFile.parameters as { properties: Record<string, unknown> }).properties;
      const mcpProps = (mcpReadFile.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(nativeProps).not.toHaveProperty('auto_full');
      expect(mcpProps).not.toHaveProperty('auto_full');
    });
  });

  describe('symbol mode', () => {
    it('native: extracts the targeted symbol body', async () => {
      const r = await nativeReadFile.handler({ path: filePath, symbol: 'targetSymbol' }, nativeCtx());
      expect(r.isError).toBeFalsy();
      expect(r.content).toContain('symbol body');
      expect(r.content).toContain('targetSymbol');
      expect(r.content).toContain('Hello, ${name}');
      // Other symbols should NOT be in the slice
      expect(r.content).not.toContain('helperOne');
      expect(r.content).not.toContain('class Container');
    });

    it('MCP: extracts the targeted symbol body (disk fallback path)', async () => {
      const out = await mcpReadFile.handler(
        { project_name: 'parity-proj', file_path: filePath, symbol: 'targetSymbol' },
        mcpCtx(),
      );
      const text = String(out);
      expect(text).toContain('symbol body');
      expect(text).toContain('targetSymbol');
      expect(text).toContain('Hello, ${name}');
      expect(text).not.toContain('helperOne');
    });

    it('native: missing symbol returns a clear error', async () => {
      const r = await nativeReadFile.handler({ path: filePath, symbol: 'doesNotExist' }, nativeCtx());
      expect(r.isError).toBeTruthy();
      expect(r.content).toContain("Symbol 'doesNotExist' not found");
    });

    it('MCP: missing symbol throws a clear error', async () => {
      await expect(
        mcpReadFile.handler(
          { project_name: 'parity-proj', file_path: filePath, symbol: 'doesNotExist' },
          mcpCtx(),
        ),
      ).rejects.toThrow(/Symbol 'doesNotExist' not found/);
    });
  });

  describe('around_line mode', () => {
    it('native: reads the equivalent declaration using its public symbol selector', async () => {
      const r = await nativeReadFile.handler({ path: filePath, symbol: 'helperOne' }, nativeCtx());
      expect(r.isError).toBeFalsy();
      expect(r.content).toContain('helperOne');
      expect(r.content).toContain('return x + 1');
    });

    it('MCP: extracts the enclosing function body', async () => {
      const out = await mcpReadFile.handler(
        { project_name: 'parity-proj', file_path: filePath, around_line: 4 },
        mcpCtx(),
      );
      const text = String(out);
      expect(text).toContain('helperOne');
      expect(text).toContain('return x + 1');
    });
  });

  describe('search_term mode', () => {
    it('native: reads the located range using its public line selector', async () => {
      const r = await nativeReadFile.handler({ path: filePath, start_line: 7, end_line: 10 }, nativeCtx());
      expect(r.isError).toBeFalsy();
      expect(r.content).toContain('[lines 7-10]');
      expect(r.content).toContain('targetSymbol');
    });

    it('MCP: centers on the first regex match', async () => {
      const out = await mcpReadFile.handler(
        { project_name: 'parity-proj', file_path: filePath, search_term: 'targetSymbol' },
        mcpCtx(),
      );
      const text = String(out);
      expect(text).toContain('Auto-scrolled');
      expect(text).toContain('targetSymbol');
    });

    it('MCP: not-found returns an informative message instead of erroring', async () => {
      const mcp = String(
        await mcpReadFile.handler(
          { project_name: 'parity-proj', file_path: filePath, search_term: 'definitely_not_present_xyz' },
          mcpCtx(),
        ),
      );
      expect(mcp).toContain('not found');
    });
  });
});
