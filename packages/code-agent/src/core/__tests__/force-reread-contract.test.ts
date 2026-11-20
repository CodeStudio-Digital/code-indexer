/**
 * The runner tells the model how to get fresh content past the already-read
 * coverage pointer and the diff-after-edit reread. The instruction must name
 * a parameter that exists in THAT tool's schema, and passing it must bypass.
 * The native read_file keeps its slim schema (no force_reread — pinned by
 * tool-schema-invariants); its `force` ("the full, current content") is the
 * fresh-read argument. The MCP reads declare force_reread: their schemas come
 * from the index tools port, so that half lives in
 * apps/http-api/workers/__tests__/index-read-fresh-param.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as descriptions from '../../tools/descriptions.js';
import { WORKFLOW_CATALOG_CONTRACTS } from '../../tools/catalog-contracts.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { CoderRunner } from '../runner.js';
import { REDUCIBLE_READ_TOOLS } from '../compaction/rolling-reduction.js';
import {
  buildCoveragePointer, freshReadParam, requestsFreshRead, rereadAfterEditHeader,
} from '../runner/guards/read-coverage.js';
import { fsTools } from '../../tools/fs.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const proto = CoderRunner.prototype as any;

function schemaOf(name: string): { properties: Record<string, unknown> } {
  return fsTools.find(t => t.name === name)!.parameters as never;
}
/** The native reads; the index (mcp__*) reads are checked against the real port. */
const NATIVE_READS = [...REDUCIBLE_READ_TOOLS].filter(name => !name.startsWith('mcp__'));

function fakeRunner() {
  const transitions: string[] = [];
  return {
    transitions,
    opts: { agentLoopV2: true, toolContext: { cwd: process.cwd() } },
    recentReadKeys: new Map(), recentWrites: new Map<string, number>(), pendingDiffRereads: new Map(),
    messages: [], setTransition: (t: string) => transitions.push(t),
  };
}
const enforce = (r: ReturnType<typeof fakeRunner>, tool: string, input: Record<string, unknown>, turn: number, id: string) =>
  proto.enforcePreReadForBridge.call(r, tool, input, turn, id);

describe('the fresh-read instruction names a real parameter of the tool that receives it', () => {
  it.each(NATIVE_READS)('%s declares its fresh-read parameter as a boolean', (name) => {
    expect(schemaOf(name).properties[freshReadParam(name)]).toMatchObject({ type: 'boolean' });
  });

  it('read_file uses force; the MCP reads use force_reread', () => {
    expect(freshReadParam('read_file')).toBe('force');
    expect(freshReadParam('mcp__read_file')).toBe('force_reread');
    expect(freshReadParam('mcp__get_file_skeleton')).toBe('force_reread');
  });

  it.each(['read_file', 'mcp__read_file'])('%s: the coverage pointer and the diff header cite that parameter', (tool) => {
    const cite = `${freshReadParam(tool)}: true`;
    const pointer = buildCoveragePointer({ toolName: tool, path: 'a.ts', start: 1, end: 5,
      segments: [{ start: 1, end: 5, turn: 1, useId: 'u' }] });
    expect(pointer).toContain(`\`${cite}\``);
    expect(rereadAfterEditHeader(tool, 'a.ts', 3)).toContain(`\`${cite}\``);
    if (tool === 'read_file') expect(pointer + rereadAfterEditHeader(tool, 'a.ts', 3)).not.toContain('force_reread');
  });

  it.each(['read_file', 'mcp__read_file'])('%s: passing it skips the diff-after-edit reread', (tool) => {
    const r = fakeRunner();
    expect(enforce(r, tool, { path: 'src/a.ts' }, 1, 'u1')).toBeNull();
    r.recentWrites.set('src/a.ts', 2);
    expect(enforce(r, tool, { path: 'src/a.ts' }, 3, 'u2')).toBeNull();
    expect(r.pendingDiffRereads.has('u2')).toBe(true); // would be served as a diff
    expect(enforce(r, tool, { path: 'src/a.ts', [freshReadParam(tool)]: true }, 4, 'u3')).toBeNull();
    expect(r.pendingDiffRereads.has('u3')).toBe(false);
    expect(r.transitions).toContain('pre-read-force-reread');
  });

  it('keeps honoring a historical force_reread on read_file, and nothing else counts', () => {
    expect(requestsFreshRead('read_file', { force_reread: true })).toBe(true);
    expect(requestsFreshRead('mcp__read_file', { force: true })).toBe(false);
    expect(requestsFreshRead('read_file', { force: false })).toBe(false);
  });

  it('no active text tells the model to pass a cut parameter to the native read_file', () => {
    const dir = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
    const files = [
      ...readdirSync(dir('../../prompts/')).filter(f => f.endsWith('.txt')).map(f => join(dir('../../prompts/'), f)),
      ...readdirSync(dir('../../skills/builtin/')).filter(f => f.endsWith('.md')).map(f => join(dir('../../skills/builtin/'), f)),
    ];
    const texts = [
      ...Object.values(descriptions).filter((v): v is string => typeof v === 'string'),
      ...Object.values(WORKFLOW_CATALOG_CONTRACTS),
      ...fsTools.map(t => t.description ?? ''),
      ...files.map(f => readFileSync(f, 'utf8')),
    ];
    const cut = /(?<!mcp__)\bread_file\b[^\n]{0,160}\b(around_line|search_term|max_lines|force_reread)\b/;
    for (const text of texts) expect(text).not.toMatch(cut);
  });

  it('the native read_file with force and a range still returns just that fresh range', async () => {
    const root = mkdtempSync(join(tmpdir(), 'force-reread-'));
    try {
      writeFileSync(join(root, 'a.ts'), 'one\ntwo\nthree\n');
      const res = await fsTools.find(t => t.name === 'read_file')!.handler(
        { path: 'a.ts', start_line: 2, end_line: 2, force: true }, { cwd: root, projectName: 'fr' } as ToolContext);
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain('[lines 2-2]');
      expect(res.content).not.toContain('three');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
