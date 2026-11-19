import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execCommand, __testing } from '@mcp/code-agent/tools/exec-command.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

let directory: string;
let script: string;
const args = ['test/*.ts', '!test/browser.ts', 'two words', 'a&b'];
const context = (): ToolContext => ({ cwd: process.cwd(), projectName: 'command-quoting-test' });

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'exec quotes '));
  script = join(directory, 'print args.mjs');
  writeFileSync(script, 'console.log("ARGS:" + JSON.stringify(process.argv.slice(2)));');
});
afterEach(async () => { await __testing.disposeAll(); });
afterAll(() => {
  if (dirname(directory) === resolve(tmpdir())) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')('Windows persistent command quoting', () => {
  it.each([false, true])('preserves quotes, spaces, literal metacharacters and chaining with tty=%s', async tty => {
    const result = await execCommand.handler({
      cmd: `"node" "${script}" "test/*.ts" "!test/browser.ts" "two words" "a&b" && echo CHAIN_OK`,
      tty,
    }, context());
    expect(result.isError, result.content).toBeFalsy();
    expect(result.content).toContain('exit=0');
    expect(result.content).toContain(`ARGS:${JSON.stringify(args)}`);
    expect(result.content).toContain('CHAIN_OK');
  });

  it('uses the same quote handling for an explicit cmd shell specification', async () => {
    const result = await execCommand.handler({ command: {
      kind: 'shell', shell: 'cmd', script: `node "${script}" "test/*.ts" "!test/browser.ts" "two words" "a&b"`,
    } }, context());
    expect(result.content).toContain('exit=0');
    expect(result.content).toContain(`ARGS:${JSON.stringify(args)}`);
  });

  it('preserves the independent PowerShell launch contract', async () => {
    const result = await execCommand.handler({ command: {
      kind: 'shell', shell: 'powershell',
      script: `& node '${script.replaceAll("'", "''")}' 'test/*.ts' '!test/browser.ts' 'two words' 'a&b'`,
    } }, context());
    expect(result.content).toContain('exit=0');
    expect(result.content).toContain(`ARGS:${JSON.stringify(args)}`);
  });
});

it.each(process.platform === 'win32' ? [false, true] : [false])('keeps argv invocation independent of shell parsing with tty=%s', async tty => {
  const result = await execCommand.handler({ command: {
    kind: 'argv', executable: process.platform === 'win32' ? 'node.exe' : 'node', args: [script, ...args, 'embedded "quote"', 'end\\'],
  }, tty }, context());
  expect(result.isError, result.content).toBeFalsy();
  expect(result.content).toContain('exit=0');
  expect(result.content).toContain(`ARGS:${JSON.stringify([...args, 'embedded "quote"', 'end\\'])}`);
});
