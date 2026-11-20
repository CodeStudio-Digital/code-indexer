/**
 * `*** Add File:` follows the same overwrite rule as write_file: over an
 * existing file it is allowed only when the session knows the current
 * content. The refusal happens in the planning phase, so the whole patch
 * writes nothing. A path the same patch deleted or moved away is a creation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../../core/tool.js';
import { applyPatchTool } from '../apply-patch.js';
import { fsTools } from '../fs.js';
import { SessionFileKnowledge } from '../file-knowledge.js';

let root: string;
let ctx: ToolContext;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'patch-overwrite-'));
  ctx = { cwd: root, projectName: 'po', fileKnowledge: new SessionFileKnowledge() } as ToolContext;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const patch = (...body: string[]) => applyPatchTool.handler({ patch: ['*** Begin Patch', ...body, '*** End Patch'].join('\n') }, ctx);
const disk = (path: string) => readFileSync(join(root, path), 'utf8');
const read = (path: string) => fsTools.find(t => t.name === 'read_file')!.handler({ path }, ctx);

describe('apply_patch Add File overwrite rule', () => {
  it('refuses the whole patch when Add File targets an existing unknown file', async () => {
    writeFileSync(join(root, 'a.txt'), 'old');
    const res = await patch('*** Add File: fresh.txt', '+fresh', '*** Add File: a.txt', '+clobber');
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/already exists/);
    expect(res.content).toMatch(/Nothing in this patch was written/);
    expect(res.content).toContain('*** Update File: a.txt');
    expect(res.guardVerdict).toMatchObject({ action: 'block', refusalKind: 'overwrite-guard' });
    expect(disk('a.txt')).toBe('old');
    expect(existsSync(join(root, 'fresh.txt'))).toBe(false);
  });

  it('refuses Add File over a known file that changed on disk since the read', async () => {
    writeFileSync(join(root, 'a.txt'), 'old');
    await read('a.txt');
    writeFileSync(join(root, 'a.txt'), 'edited elsewhere');
    const res = await patch('*** Add File: a.txt', '+mine');
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/changed on disk/);
    expect(disk('a.txt')).toBe('edited elsewhere');
  });

  it('allows Add File over an existing file the session read', async () => {
    writeFileSync(join(root, 'a.txt'), 'old');
    await read('a.txt');
    expect((await patch('*** Add File: a.txt', '+new')).isError).toBeFalsy();
    expect(disk('a.txt')).toBe('new');
  });

  it('treats a path deleted or moved away earlier in the same patch as a creation', async () => {
    writeFileSync(join(root, 'a.txt'), 'old');
    writeFileSync(join(root, 'b.txt'), 'b\n');
    const res = await patch('*** Delete File: a.txt', '*** Add File: a.txt', '+recreated',
      '*** Update File: b.txt', '*** Move to: c.txt', '@@', '-b', '+c', '*** Add File: b.txt', '+again');
    expect(res.isError).toBeFalsy();
    expect(disk('a.txt')).toBe('recreated');
    expect(disk('b.txt')).toBe('again');
    expect(disk('c.txt')).toBe('c\n');
  });

  it('creates a new path, and the session then knows what it wrote', async () => {
    expect((await patch('*** Add File: new.txt', '+hello')).isError).toBeFalsy();
    expect(disk('new.txt')).toBe('hello');
    const write = fsTools.find(t => t.name === 'write_file')!;
    expect((await write.handler({ path: 'new.txt', content: 'replaced' }, ctx)).isError).toBeFalsy();
  });

  it('keeps knowledge of a file the session updated with a hunk', async () => {
    writeFileSync(join(root, 'a.txt'), 'one\n');
    await read('a.txt');
    expect((await patch('*** Update File: a.txt', '@@', '-one', '+two')).isError).toBeFalsy();
    expect((await patch('*** Add File: a.txt', '+three')).isError).toBeFalsy();
    expect(disk('a.txt')).toBe('three');
  });
});
