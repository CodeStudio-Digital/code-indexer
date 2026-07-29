#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const manifest = join(root, 'native', 'agent-runtime', 'Cargo.toml');
const targetDirectory = join(
  root,
  'native',
  'agent-runtime',
  'target',
  'performance-harness',
);
const reportDirectory = join(root, '.tmp', 'rust-agent-performance');
const cargo = process.env.CARGO ?? 'cargo';
const shared = [
  '+1.97.1',
  '--manifest-path',
  manifest,
  '-p',
  'agent-runner',
  '--release',
  '--features',
  'performance-harness',
  '--locked',
];
const environment = {
  ...process.env,
  CARGO_TARGET_DIR: targetDirectory,
};

function execute(cargoArguments, capture = false) {
  return spawnSync(cargo, cargoArguments, {
    cwd: root,
    env: environment,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  });
}

const build = execute([
  ...shared.slice(0, 1),
  'build',
  ...shared.slice(1),
  '--bin',
  'agent-runner',
  '--example',
  'agent-runner-startup-benchmark',
]);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const benchmark = execute([
  ...shared.slice(0, 1),
  'run',
  ...shared.slice(1),
  '--example',
  'agent-runner-startup-benchmark',
  '--',
  ...process.argv.slice(2),
], true);
if (benchmark.stderr) process.stderr.write(benchmark.stderr);
if (benchmark.stdout) process.stdout.write(benchmark.stdout);

const resultLine = benchmark.stdout
  ?.split(/\r?\n/)
  .find((line) => line.includes('"schema":"GATE_PERF_01_RESULT_V1"'));
if (resultLine) {
  const result = JSON.parse(resultLine);
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(
    join(reportDirectory, `GATE-PERF-01-${process.platform}-${process.arch}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
    { encoding: 'utf8', flag: 'w' },
  );
} else if (benchmark.status === 0) {
  throw new Error('performance benchmark exited without an auditable result');
}

if (benchmark.error) throw benchmark.error;
process.exit(benchmark.status ?? 1);
