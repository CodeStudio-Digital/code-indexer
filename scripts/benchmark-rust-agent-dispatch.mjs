// Feature-only native executor benchmark; never changes the installed package.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = join(root, 'native/agent-runtime/target/performance-harness');
const output = resolve(process.argv[2] ?? join(root, `.tmp/rust-agent-performance/GATE-PERF-03-${process.platform}-${process.arch}.json`));
const result = spawnSync(process.env.CARGO ?? 'cargo', ['+1.97.1', 'run', '--manifest-path',
  join(root, 'native/agent-runtime/Cargo.toml'), '-p', 'agent-runner', '--release', '--locked',
  '--features', 'performance-harness', '--example', 'agent-runner-dispatch-benchmark'], {
  cwd: root, env: { ...process.env, CARGO_TARGET_DIR: target }, encoding: 'utf8', windowsHide: true,
});
if (result.error) throw result.error;
if (result.stderr) process.stderr.write(result.stderr);
const line = result.stdout?.split(/\r?\n/).find(line => line.includes('"schema":"GATE_PERF_03_RESULT_V1"'));
if (line) {
  const binary = join(target, 'release/examples', `agent-runner-dispatch-benchmark${process.platform === 'win32' ? '.exe' : ''}`);
  const report = { ...JSON.parse(line), measuredAt: new Date().toISOString(),
    benchmarkBinarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex') };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} else if (result.status === 0) {
  throw new Error('native dispatch benchmark produced no auditable result');
}
process.exitCode = result.status ?? 1;
