/** Offline regrade only: original provider traces and V1 verdicts are preserved.
 * Usage: node scripts/regrade-agent-config-verifier.mjs input.json output.json
 * Apply to BOTH baseline and candidates; never rerun a provider for a label fix. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { identifiesDisconnectedConfiguration } from '../evals/agent-effectiveness/disconnected-config.mjs';
const [input, output] = process.argv.slice(2).map(path => resolve(path));
assert.ok(input && output && input !== output, 'A separate output is required');
const original = readFileSync(input), data = JSON.parse(original.toString('utf8'));
const changes = [];
for (const record of data.results) {
  const result = record.result ?? (record.case_id ? record : null);
  if (result?.case_id !== 'explore_session_expiry') continue;
  assert.ok(result.verification.checks && !result.verificationV1, 'Expected an original V1 verdict');
  const before = result.verification;
  const checks = { ...before.checks, identifies_disconnected_config: identifiesDisconnectedConfiguration(result.final_text) };
  result.verificationV1 = before;
  result.verification = { ...before, checks, passed: Object.values(checks).every(value => value === true) };
  if (before.passed !== result.verification.passed) changes.push({ runId: result.run_id, repetition: result.repetition,
    before: before.passed, after: result.verification.passed });
}
data.offlineVerifierAudit = { version: 2, input, inputSha256: createHash('sha256').update(original).digest('hex'),
  verifierSha256: createHash('sha256').update(readFileSync(new URL('../evals/agent-effectiveness/disconnected-config.mjs', import.meta.url))).digest('hex'),
  reason: 'Recognize Portuguese gender/copula variants of unused/unconsumed configuration; all other oracle conditions unchanged.', changes };
writeFileSync(output, JSON.stringify(data, null, 2));
console.log(JSON.stringify({ output, changes }));
