/** Combine immutable checkpoints without hiding interrupted or terminally failed attempts.
 * Usage: node --import tsx scripts/summarize-agent-reliability.mjs <manifest.json>
 * The manifest names every input explicitly; unrelated/invalidated runs are never discovered.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { captureReliabilitySource } from './reliability-source-manifest.ts';

const read = path => JSON.parse(readFileSync(resolve(path), 'utf8'));
const config = read(process.argv[2]);
const records = new Map();
const buildEvidence = [];
const key = job => `${job.caseId ?? job.case_id}/${job.model ?? job.requested_model}/${job.repetition}`;
const add = record => {
  const id = key(record.job ?? record.result);
  assert.ok(!records.has(id), `Duplicate attempt: ${id}`);
  records.set(id, record);
};
for (const path of config.checkpoints) {
  const data = read(path);
  buildEvidence.push({ path, ...data.buildEvidence });
  for (const result of data.results) add({ path, result, status: 'completed' });
}
for (const path of config.supervisors) {
  const data = read(path);
  for (const record of data.results) {
    assert.ok(!record.result || key(record.job) === key(record.result), `Mismatched checkpoint/job: ${path}`);
    if (record.buildEvidence) buildEvidence.push({ path: record.checkpoint, ...record.buildEvidence });
    add({ ...record, path });
  }
}
for (const record of config.interrupted) add(record);
// The existing harness deliberately declines submit_plan after capturing it.
// Preserve that documented terminal contract; unrelated aborts remain failures.
const completed = result => !!result && !result.terminal.error && (result.terminal.reason === 'completed'
  || (result.case_id === 'plan_login_lockout' && result.terminal.reason === 'aborted'
    && result.plans.length > 0 && result.tool_calls.some(tool => tool.name === 'submit_plan' && tool.started)));
const correct = record => record.status === 'completed' && completed(record.result)
  && record.result.verification.passed;
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
};
const metrics = attempts => {
  const results = attempts.flatMap(record => record.result ? [record.result] : []);
  const input = results.reduce((sum, result) => sum + (result.usage.prompt_tokens_total ?? result.usage.input_tokens ?? 0), 0);
  const output = results.reduce((sum, result) => sum + (result.usage.output_tokens ?? 0), 0);
  const successes = attempts.filter(correct).length;
  const uncertainUsage = attempts.filter(record => !completed(record.result) || record.status !== 'completed').length;
  return {
    attempts: attempts.length, artifactCorrect: results.filter(result => result.verification.passed).length,
    completedCorrect: successes,
    completedCorrectAndGuardrails: attempts.filter(record => correct(record) && record.result.guardrails.passed).length,
    completedCorrectAndEfficient: attempts.filter(record => correct(record) && record.result.guardrails.passed && record.result.efficiency.passed).length,
    failedProcess: attempts.filter(record => record.status !== 'completed').length,
    failedTerminal: results.filter(result => !completed(result)).length,
    inputTokensReported: input, outputTokensReported: output, tokensReported: input + output,
    estimatedUsdReported: (input * 1.4 + output * 4.4) / 1_000_000,
    attemptsWithIncompleteCost: uncertainUsage,
    reportedTokensPerCorrectTask: successes ? (input + output) / successes : null,
    elapsedMs: { median: percentile(results.map(result => result.elapsed_ms), .5), p95: percentile(results.map(result => result.elapsed_ms), .95) },
  };
};
const all = [...records.values()];
const baseline = read(config.baseline);
const baselineRecords = baseline.results.map(result => ({ result, status: 'completed' }));
const pairedBaseline = baselineRecords.filter(record => records.has(key(record.result)));
const pairedCandidate = pairedBaseline.map(record => records.get(key(record.result)));
const paired = pairedBaseline.map((before, index) => {
  const after = pairedCandidate[index];
  return { key: key(before.result), before: correct(before), after: correct(after),
    beforeTerminal: before.result.terminal, afterTerminal: after.result?.terminal ?? { reason: after.status },
    delta: Number(correct(after)) - Number(correct(before)) };
});
// A descriptive paired bootstrap, never a substitute for randomized/alternated A/B.
let seed = 0x71a9;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const samples = [];
if (paired.length) for (let iteration = 0; iteration < 10_000; iteration++) {
  let sum = 0;
  for (let index = 0; index < paired.length; index++) sum += paired[Math.floor(random() * paired.length)].delta;
  samples.push(sum / paired.length);
}
const frozenAfter = captureReliabilitySource(resolve(config.frozenSource));
const sourceStable = buildEvidence.every(evidence => evidence.source.sha256 === frozenAfter.sha256);
const expected = config.expected;
const expectedKeys = new Set(expected.map(key));
assert.equal(expectedKeys.size, expected.length, 'Duplicate expected attempts');
for (const id of records.keys()) assert.ok(expectedKeys.has(id), `Unexpected attempt: ${id}`);
const missing = expected.filter(job => !records.has(key(job)));
const cases = [...new Set(expected.map(job => job.caseId))];
const report = {
  generatedAt: new Date().toISOString(), sourceStable, frozenAfter,
  currentSource: captureReliabilitySource(resolve('.')),
  expectedAttempts: expected.length, missing, overall: metrics(all),
  perCase: Object.fromEntries(cases.map(caseId => [caseId, metrics(all.filter(record => (record.job?.caseId ?? record.result?.case_id) === caseId))])),
  paired: { pairs: paired.length, baseline: metrics(pairedBaseline), candidate: metrics(pairedCandidate),
    successRateDelta: paired.length ? paired.reduce((sum, row) => sum + row.delta, 0) / paired.length : null,
    descriptiveBootstrap95: [percentile(samples, .025), percentile(samples, .975)], rows: paired },
  limitations: [
    'Baseline and candidate were not interleaved. Concurrent build/test load differed; latency differences cannot be attributed to the implementation.',
    'Five integrated cases have a paired baseline; 25 focused scenarios have candidate-only measurements.',
    'Runtime is the explicitly frozen snapshot; current source and packaged validation have separate hashes/evidence.',
    'Cost uses recorded local model_prices estimates (1.4 input / 4.4 output USD per million). Failed/interrupted usage can be missing; this is not billing evidence.',
    'Artifact correctness alone is not success. Error/missing terminals fail. The existing plan harness deliberately declines a captured submit_plan; only that documented abort is an expected terminal.',
    'Task success and retrieval efficiency are separate: the harness guardrails measure tool errors, duplicate executions and repeated reads. A recovered shell error remains a guardrail failure without erasing a completed, verified task.',
  ],
  attempts: all, buildEvidence,
};
const output = resolve(config.output); mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, sourceStable, expected: expected.length, measured: all.length, missing: missing.length,
  overall: report.overall, paired: { pairs: paired.length, baseline: report.paired.baseline, candidate: report.paired.candidate,
    successRateDelta: report.paired.successRateDelta, descriptiveBootstrap95: report.paired.descriptiveBootstrap95 } }, null, 2));
if (!sourceStable) process.exitCode = 1;
