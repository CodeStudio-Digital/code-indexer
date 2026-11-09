import { readFileSync, statSync } from 'node:fs';

/** PID reuse must never turn an earlier run's checkpoint into this job's result. */
export function readFreshBenchmarkCheckpoint(path, launchedAt, job) {
  try {
    if (statSync(path).mtimeMs < launchedAt) return null;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const result = data.results?.[0];
    if (!result || result.case_id !== job.caseId || result.requested_model !== job.model || result.repetition !== job.repetition) return null;
    return data;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}
