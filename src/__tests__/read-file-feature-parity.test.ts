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
 * MCP read_file (src/apps/mcp-server/tools/file.ts). Both must accept the
 * same set of "smart" parameters — symbol, around_line, search_term, force —
 * so the agent's decision tree applies regardless of which one it picks.
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

  describe('schemas advertise the same smart parameters', () => {
    it('both schemas declare symbol, around_line, search_term, force', () => {
      const nativeProps = (nativeReadFile.parameters as { properties: Record<string, unknown> }).properties;
      const mcpProps = (mcpReadFile.inputSchema as { properties: Record<string, unknown> }).properties;
      for (const key of ['symbol', 'around_line', 'search_term', 'force', 'start_line', 'end_line', 'max_lines']) {
        expect(nativeProps).toHaveProperty(key);
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

    it('MCP: missing symbol throws a clear error', () => {
      expect(() =>
        mcpReadFile.handler(
          { project_name: 'parity-proj', file_path: filePath, symbol: 'doesNotExist' },
          mcpCtx(),
        ),
      ).toThrow(/Symbol 'doesNotExist' not found/);
    });
  });

  describe('around_line mode', () => {
    it('native: extracts the enclosing function body', async () => {
      // Line 4 (`return x + 1;`) lives inside helperOne (declared on line 3)
      const r = await nativeReadFile.handler({ path: filePath, around_line: 4 }, nativeCtx());
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
    it('native: centers on the first regex match', async () => {
      const r = await nativeReadFile.handler({ path: filePath, search_term: 'targetSymbol' }, nativeCtx());
      expect(r.isError).toBeFalsy();
      expect(r.content).toContain('Auto-scrolled');
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

    it('both: not-found returns an informative message instead of erroring', async () => {
      const native = await nativeReadFile.handler(
        { path: filePath, search_term: 'definitely_not_present_xyz' },
        nativeCtx(),
      );
      expect(native.isError).toBeFalsy();
      expect(native.content).toContain('not found');

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
