import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

const readFileTool = fsTools.find((t) => t.name === 'read_file')!;

describe('read_file native — auto-full + rich header', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'rf-auto-'));
    mkdirSync(join(cwd, 'src'), { recursive: true });
    // Small file: 50 lines
    writeFileSync(
      join(cwd, 'src', 'small.ts'),
      Array.from({ length: 50 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n'),
    );
    // Big file: 1000 lines (above the 800 auto-full threshold)
    writeFileSync(
      join(cwd, 'src', 'big.ts'),
      Array.from({ length: 1000 }, (_, i) => `const x${i + 1} = ${i + 1}; // line ${i + 1}`).join('\n'),
    );
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function ctx(): ToolContext {
    return { cwd, projectName: 'test' };
  }

  it('returns the WHOLE file in one shot when ≤800 lines (auto-full)', async () => {
    const r = await readFileTool.handler({ path: 'src/small.ts' }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('[auto-full: file ≤800 lines]');
    expect(r.content).toContain('50 lines');
    // No truncation footer
    expect(r.content).not.toContain('more lines');
    // First and last line both present
    expect(r.content).toContain('const line1 =');
    expect(r.content).toContain('const line50 =');
  });

  it('paginates a >800-line file with the rich header signaling auto-full off', async () => {
    const r = await readFileTool.handler({ path: 'src/big.ts' }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('1000 lines');
    expect(r.content).toContain('[auto-full off — file > 800 lines, pass force=true');
    // Default max_lines is 400 → reads 1-400
    expect(r.content).toContain('[lines 1-400]');
    expect(r.content).toContain('600 more lines');
  });

  it('force=true returns the entire >800-line file', async () => {
    const r = await readFileTool.handler({ path: 'src/big.ts', force: true }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('[lines 1-1000]');
    expect(r.content).toContain('const x1 =');
    expect(r.content).toContain('const x1000 =');
    expect(r.content).not.toContain('more lines');
  });

  it('explicit start_line skips auto-full', async () => {
    const r = await readFileTool.handler({ path: 'src/small.ts', start_line: 20 }, ctx());
    expect(r.isError).toBeFalsy();
    // 50-line file, start=20 → reads 20-50 (max_lines default 400)
    expect(r.content).toContain('[lines 20-50]');
    // Auto-full only kicks in when no range is specified
    expect(r.content).not.toContain('[auto-full: file ≤800 lines]');
  });

  it('rich header always carries total_lines + ext upfront', async () => {
    const r = await readFileTool.handler({ path: 'src/big.ts', start_line: 100, end_line: 105 }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/^src\/big\.ts \| 1000 lines \| ts/);
    expect(r.content).toContain('[lines 100-105]');
  });

  it('search_term centers the window on the first match', async () => {
    const r = await readFileTool.handler({ path: 'src/big.ts', search_term: 'line 750' }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Auto-scrolled to line 750');
    expect(r.content).toContain('const x750 =');
  });

  it('search_term returns a not-found message instead of erroring', async () => {
    const r = await readFileTool.handler({ path: 'src/big.ts', search_term: 'definitely_not_in_file_xyz' }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('not found');
  });
});
