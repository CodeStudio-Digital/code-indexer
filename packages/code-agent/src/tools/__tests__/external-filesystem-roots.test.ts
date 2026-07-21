import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { fsTools } from '../fs.js';
import { globTool } from '../glob.js';
import { shellTools } from '../shell.js';

const readFile = fsTools.find((tool) => tool.name === 'read_file')!;
const writeFile = fsTools.find((tool) => tool.name === 'write_file')!;
const runCommand = shellTools.find((tool) => tool.name === 'run_command')!;

let projectRoot: string;
let externalRoot: string;
let outsideRoot: string;

function ctx(access: 'read' | 'write'): ToolContext {
  return {
    cwd: projectRoot,
    projectName: 'external-root-test',
    externalRoots: [{ id: 7, rootPath: externalRoot, access }],
  } as ToolContext;
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'external-root-project-'));
  externalRoot = mkdtempSync(join(tmpdir(), 'external-root-granted-'));
  outsideRoot = mkdtempSync(join(tmpdir(), 'external-root-outside-'));
  writeFileSync(join(externalRoot, 'source.ts'), 'export const value = 1;');
  writeFileSync(join(outsideRoot, 'secret.txt'), 'not authorized');
});

afterEach(() => {
  for (const path of [projectRoot, externalRoot, outsideRoot]) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('authorized external filesystem roots', () => {
  it('reads and globs absolute paths under a read-only root', async () => {
    const read = await readFile.handler({ path: join(externalRoot, 'source.ts') }, ctx('read'));
    const glob = await globTool.handler({ path: externalRoot, pattern: '**/*.ts' }, ctx('read'));

    expect(read.isError).toBeFalsy();
    expect(read.content).toContain('value = 1');
    expect(glob.isError).toBeFalsy();
    expect(glob.content).toContain(join(externalRoot, 'source.ts'));
  });

  it('enforces read-only and permits writes only after an explicit write grant', async () => {
    const target = join(externalRoot, 'source.ts');
    const denied = await writeFile.handler({ path: target, content: 'denied' }, ctx('read'));
    const allowed = await writeFile.handler({ path: target, content: 'allowed' }, ctx('write'));

    expect(denied.isError).toBe(true);
    expect(denied.content).toContain('read-only authorized root');
    expect(allowed.isError).toBeFalsy();
    expect(readFileSync(target, 'utf8')).toBe('allowed');
  });

  it('rejects ungranted paths and symlink escapes', async () => {
    const ungranted = await readFile.handler({ path: join(outsideRoot, 'secret.txt') }, ctx('read'));
    symlinkSync(outsideRoot, join(externalRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const escaped = await readFile.handler({ path: join(externalRoot, 'escape', 'secret.txt') }, ctx('read'));

    expect(ungranted.isError).toBe(true);
    expect(ungranted.content).toContain('outside the project and authorized roots');
    expect(escaped.isError).toBe(true);
    expect(escaped.content).toContain('symlink or junction');
  });

  it('keeps local shell cwd project-scoped even for an authorized root', async () => {
    const result = await runCommand.handler({ cwd: externalRoot, command: 'dir' }, ctx('write'));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('local shell execution stays project-scoped');
  });
});
