#!/usr/bin/env node
/**
 * Launch the filesystem-session migrator as a headless Electron main process.
 *
 * The desktop build owns both the better-sqlite3 ABI and the safeStorage
 * keychain integration used to migrate Company secrets. ELECTRON_RUN_AS_NODE
 * provides the former but deliberately omits `app`/`safeStorage`, so all three
 * operations use one real, windowless Electron main bootstrap.
 */
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronExecutable = require('electron');
const bootstrap = join(repoRoot, 'scripts', 'sessions-fs-migrate', 'electron-main.cjs');
const phaseDirectory = join(repoRoot, '.tmp');
const phaseLog = join(
  phaseDirectory,
  `sessions-fs-migrate-${process.pid}-${Date.now()}.log`,
);
mkdirSync(phaseDirectory, { recursive: true });
writeFileSync(phaseLog, '', { encoding: 'utf8', mode: 0o600 });
const {
  ELECTRON_RUN_AS_NODE: _discardElectronRunAsNode,
  ...electronEnv
} = process.env;

const child = spawn(
  electronExecutable,
  [bootstrap, ...process.argv.slice(2)],
  {
    cwd: repoRoot,
    env: {
      ...electronEnv,
      MCP_SESSIONS_MIGRATE_PHASE_LOG: phaseLog,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  },
);

let phaseOffset = 0;
const flushPhaseLog = () => {
  const bytes = readFileSync(phaseLog);
  if (bytes.length <= phaseOffset) return;
  process.stderr.write(bytes.subarray(phaseOffset));
  phaseOffset = bytes.length;
};
const phaseTimer = setInterval(flushPhaseLog, 250);

const exitCode = await new Promise((resolveExit) => {
  child.once('error', (error) => {
    process.stderr.write(`[sessions:fs-migrate] failed to start: ${error.message}\n`);
    resolveExit(1);
  });
  child.once('exit', (code, signal) => {
    if (signal) {
      process.stderr.write(`[sessions:fs-migrate] Electron exited on signal ${signal}\n`);
    }
    resolveExit(code ?? 1);
  });
});

clearInterval(phaseTimer);
flushPhaseLog();
rmSync(phaseLog, { force: true });
process.exitCode = exitCode;
