import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginDatabaseJob, cancelDatabaseJob, readDatabaseJob } from '../jobs.js';

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'db-job-test-'));
  directories.push(directory); vi.stubEnv('MCP_DATA_DIR', directory); return directory;
}
it('persists progress, scopes receipts, and refuses replay of an import ID', () => {
  const directory = setup();
  const job = beginDatabaseJob('project-a/conn-1', 'import');
  job.update({ total: 5, completed: 2, effect: 'unknown' });
  expect(readDatabaseJob('project-a/conn-1', job.id)).toMatchObject({ completed: 2, state: 'running' });
  expect(() => readDatabaseJob('project-b/conn-1', job.id)).toThrow(/not found/);
  expect(() => beginDatabaseJob('project-a/conn-1', 'import', job.id)).toThrow(/already/);
  cancelDatabaseJob('project-a/conn-1', job.id);
  expect(job.signal.aborted).toBe(true);
  expect(readDatabaseJob('project-a/conn-1', job.id).state).toBe('running');
  job.finish({ state: 'cancelled', effect: 'none' });
  expect(readDatabaseJob('project-a/conn-1', job.id)).toMatchObject({ state: 'cancelled', effect: 'none' });
  const owner = readdirSync(join(directory, 'database-jobs'))[0];
  const receipt = readFileSync(join(directory, 'database-jobs', owner, job.id + '.json'), 'utf8');
  expect(receipt).not.toContain('project-a');
});
it('reports an interrupted import as unknown after restart and never resumes it', async () => {
  setup();
  const job = beginDatabaseJob('scope', 'import');
  vi.resetModules();
  const recovered = await import('../jobs.js');
  expect(recovered.readDatabaseJob('scope', job.id)).toMatchObject({ state: 'interrupted', effect: 'unknown' });
  expect(() => recovered.beginDatabaseJob('scope', 'import', job.id)).toThrow(/already/);
  job.finish({ state: 'failed', effect: 'unknown' });
});
