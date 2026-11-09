import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError, type DbJobStatus } from '@mcp/api-bus';
import { mcpDataDir } from '@mcp/shared/utils/config.js';

const active = new Map<string, AbortController>();
const opaque = (value: string) => createHash('sha256').update(value).digest('hex');
const validId = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
function pathFor(scope: string, id: string): string {
  if (!validId(id)) throw new ApiError('db_job_id', 400, 'Invalid database job ID.');
  return join(mcpDataDir(), 'database-jobs', opaque(scope), id + '.json');
}

/** Durable receipts, separate from operational telemetry. SQL and row values
 * are never persisted here. An interrupted import is never replayed. */
export function beginDatabaseJob(scope: string, kind: 'export' | 'import', requestedId?: string, parentSignal?: AbortSignal) {
  parentSignal?.throwIfAborted();
  const id = requestedId ?? randomUUID();
  const path = pathFor(scope, id), directory = join(path, '..');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (readdirSync(directory).filter(name => name.endsWith('.json')).length >= 1024) throw new ApiError('db_job_quota', 429, 'Database job receipt quota reached. Archive old receipts before starting another job.');
  let status: DbJobStatus = { version: 1, jobId: id, kind, state: 'running', effect: 'none', completed: 0, startedAt: Date.now(), updatedAt: Date.now() };
  try { writeFileSync(path, JSON.stringify(status), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ApiError('db_job_exists', 409, 'This job already has a receipt. Inspect it; do not replay an import.', { jobId: id });
    throw error;
  }
  const controller = new AbortController();
  const key = opaque(scope) + '/' + id;
  active.set(key, controller);
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  const update = (patch: Partial<Pick<DbJobStatus, 'state' | 'effect' | 'completed' | 'total'>>) => {
    status = { ...status, ...patch, updatedAt: Date.now() };
    const temporary = path + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, JSON.stringify(status), { mode: 0o600 });
    renameSync(temporary, path);
  };
  return { id, signal, update, finish(patch: Partial<Pick<DbJobStatus, 'state' | 'effect' | 'completed' | 'total'>>) {
    try { update(patch); } finally { active.delete(key); }
  } };
}

export function readDatabaseJob(scope: string, id: string): DbJobStatus {
  const path = pathFor(scope, id);
  try {
    if (statSync(path).size > 8192) throw new Error('oversized');
    const result = JSON.parse(readFileSync(path, 'utf8')) as DbJobStatus;
    if (result.version !== 1 || result.jobId !== id) throw new Error('invalid');
    if (result.state === 'running' && !active.has(opaque(scope) + '/' + id)) {
      return { ...result, state: 'interrupted', effect: result.kind === 'import' ? 'unknown' : 'none' };
    }
    return result;
  } catch { throw new ApiError('db_job_not_found', 404, 'Database job not found in this connection scope.'); }
}

export function cancelDatabaseJob(scope: string, id: string): DbJobStatus {
  const status = readDatabaseJob(scope, id);
  active.get(opaque(scope) + '/' + id)?.abort(new Error('Database job cancelled'));
  return status; // Acknowledging cancel does not assert physical rollback/completion.
}
