/** Resume interrupted fixture evaluations with one bounded process per job.
 * A crashed attempt stays failed; the supervisor never retries it silently. */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createWriteStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readFreshBenchmarkCheckpoint } from './reliability-checkpoint.mjs';
const require = createRequire(import.meta.url);
const electron = require('electron');
const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1] || fallback; };
const sourceRoot = resolve(arg('--source', '.'));
const input = JSON.parse(readFileSync(resolve(arg('--plan', '')), 'utf8'));
if (!Array.isArray(input.jobs) || input.jobs.some(j => typeof j.caseId !== 'string' || j.model !== 'glm-5.3' || !Number.isSafeInteger(j.repetition) || j.repetition < 1)) {
  throw new Error('An explicit GLM 5.3 job plan is required');
}
const output = resolve('.tmp/agent-ide-reliability', `supervised-${Date.now()}-${process.pid}`);
mkdirSync(output, { recursive: true });
const results = [];
const started = Date.now();
let estimatedUsd = 0;
const maximumUsd = 5, maximumMinutes = 90;
const persist = () => writeFileSync(join(output, 'report.json'), JSON.stringify({
  sourceRoot, plan: input, maximumUsd, maximumMinutes, estimatedUsd,
  costScope: 'Completed usage only; interrupted calls may have additional unreported cost.',
  results, remaining: input.jobs.slice(results.length),
}, null, 2));
persist();
for (const [index, job] of input.jobs.entries()) {
  if (estimatedUsd >= maximumUsd || Date.now() - started >= maximumMinutes * 60_000) break;
  const jobFile = join(output, `job-${index}.json`);
  writeFileSync(jobFile, JSON.stringify([job]));
  const log = createWriteStream(join(output, `job-${index}.log`));
  const launchedAt = Date.now();
  const child = spawn(electron, ['--import', 'tsx', 'scripts/bench-agent-reliability-live.ts', '--jobs-file', jobFile,
    '--exact-inspect-return-v2', '--max-estimated-usd', '1', '--max-minutes', '8'], {
    cwd: resolve('.'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1',
      RELIABILITY_EVAL_SOURCE_ROOT: sourceRoot, TSX_TSCONFIG_PATH: join(sourceRoot, 'tsconfig.json') },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  console.log(JSON.stringify({ index: index + 1, total: input.jobs.length, job, pid: child.pid }));
  let forced = false;
  const timer = setTimeout(() => {
    forced = true;
    // This PID is returned directly by our spawn and has not exited.
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
  }, 8 * 60_000);
  const exit = await new Promise(done => {
    child.once('error', error => done({ error: error.message }));
    child.once('close', (code, signal) => done({ code, signal }));
  });
  clearTimeout(timer); log.end();
  const checkpoint = resolve('.tmp/agent-effectiveness/reports', `in-progress-${child.pid}.json`);
  const data = readFreshBenchmarkCheckpoint(checkpoint, launchedAt, job);
  const result = data?.results?.[0] ?? null;
  if (result) estimatedUsd += ((result.usage.prompt_tokens_total ?? result.usage.input_tokens) * 1.4 + result.usage.output_tokens * 4.4) / 1_000_000;
  const profiles = readdirSync('.tmp/agent-ide-reliability').filter(name => name.startsWith('live-profile-') && name.endsWith(`-${child.pid}`));
  const cleanup = profiles.map(name => {
    const profile = resolve('.tmp/agent-ide-reliability', name);
    const scrub = spawnSync(electron, ['scripts/reliability-profile-cleanup.cjs', profile], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    return { profile, status: scrub.status, output: scrub.stdout, error: scrub.error?.message };
  });
  results.push({ job, pid: child.pid, launchedAt, forced, exit, checkpoint, buildEvidence: data?.buildEvidence, result,
    status: !forced && exit.code === 0 && result ? 'completed' : 'failed_process', cleanup });
  persist();
  console.log(JSON.stringify({ completed: results.length, status: results.at(-1).status, correct: result?.verification.passed, estimatedUsd }));
  if (cleanup.some(x => x.status !== 0)) throw new Error('Evaluation profile cleanup failed');
}
console.log(output);
