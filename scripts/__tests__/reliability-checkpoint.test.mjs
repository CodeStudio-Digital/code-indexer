import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFreshBenchmarkCheckpoint } from '../reliability-checkpoint.mjs';

test('a reused PID cannot borrow stale or mismatched paid-evaluation evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'reliability-checkpoint-'));
  const path = join(root, 'in-progress-123.json');
  const job = { caseId: 'inspect', model: 'glm-5.3', repetition: 2 };
  const result = { case_id: job.caseId, requested_model: job.model, repetition: job.repetition };
  const start = Date.now();
  try {
    assert.equal(readFreshBenchmarkCheckpoint(path, start, job), null);
    writeFileSync(path, JSON.stringify({ results: [result] }));
    utimesSync(path, new Date(start - 10_000), new Date(start - 10_000));
    assert.equal(readFreshBenchmarkCheckpoint(path, start, job), null);
    writeFileSync(path, JSON.stringify({ results: [{ ...result, repetition: 1 }] }));
    utimesSync(path, new Date(start + 1000), new Date(start + 1000));
    assert.equal(readFreshBenchmarkCheckpoint(path, start, job), null);
    writeFileSync(path, JSON.stringify({ results: [result] }));
    utimesSync(path, new Date(start + 1000), new Date(start + 1000));
    assert.deepEqual(readFreshBenchmarkCheckpoint(path, start, job).results, [result]);
    writeFileSync(path, '{');
    assert.equal(readFreshBenchmarkCheckpoint(path, start, job), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
