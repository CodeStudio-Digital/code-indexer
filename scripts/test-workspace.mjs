#!/usr/bin/env node
/** Run database tests with the desktop ABI, and process fixtures with real Node. */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electron = require('electron');
const vitest = resolve(root, 'node_modules/vitest/vitest.mjs');
const reports = resolve(root, '.tmp/test-workspace');
mkdirSync(reports, { recursive: true });

// These fixtures spawn process.execPath as a real Node executable. They do not
// load the Electron-built SQLite addon and must not trigger an ABI rebuild.
const nodeOnly = [
  'packages/plugin-host/src/capabilities/__tests__/exec.test.ts',
  'packages/code-agent/src/tools/__tests__/git-tools.test.ts',
  'packages/code-agent/src/tools/__tests__/worktree.test.ts',
  'src/__tests__/worktree.test.ts',
  'packages/api-handlers/src/debug/__tests__/adapter-process.test.ts',
  'packages/plugin-sdk/src/cli/__tests__/cli-build.test.ts',
  'packages/services/src/lsp/__tests__/lsp-server-manager.test.ts',
  'packages/code-agent/src/ports/__tests__/shell-port.test.ts',
];
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// An in-repository TEMP changes Git fixture semantics ("outside a repository").
const temp = process.platform === 'win32' && env.LOCALAPPDATA
  ? join(env.LOCALAPPDATA, 'Temp') : tmpdir();
env.TEMP = temp;
env.TMP = temp;
const options = ['--maxWorkers=4', '--reporter=default', '--reporter=json'];

function run(executable, name, filters, runtimeEnv) {
  console.log(`\nWorkspace tests: ${name}`);
  const result = spawnSync(executable, [vitest, 'run', ...filters, ...options,
    `--outputFile.json=${join(reports, `${name}.json`)}`], {
    cwd: root, stdio: 'inherit', env: runtimeEnv,
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) {
    console.error(`Workspace tests ${name} failed: exit=${result.status}, signal=${result.signal ?? 'none'}`);
  }
  return result.status === 0;
}

const desktopPassed = run(electron, 'electron', nodeOnly.flatMap(file => ['--exclude', file]),
  { ...env, ELECTRON_RUN_AS_NODE: '1' });
const nodePassed = run(process.execPath, 'node', nodeOnly, env);
console.log('\nWorkspace tests: Node build scripts');
const scriptResult = spawnSync(process.execPath, ['--test',
  'scripts/__tests__/resolve-build-aliases.test.mjs',
  'scripts/prune-build-output.test.mjs',
  'scripts/release/asar-closure.test.mjs',
], { cwd: root, stdio: 'inherit', env, windowsHide: true });
if (scriptResult.error) console.error(scriptResult.error.message);
process.exitCode = desktopPassed && nodePassed && scriptResult.status === 0 ? 0 : 1;
