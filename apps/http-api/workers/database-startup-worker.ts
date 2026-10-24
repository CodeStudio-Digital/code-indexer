import { parentPort, workerData } from 'node:worker_threads';
import { isAbsolute } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';

if (!parentPort || typeof workerData?.dbPath !== 'string' || !isAbsolute(workerData.dbPath)) {
  throw new Error('database startup requires an absolute database path and a parent');
}
// CodeIndexDB preserves maintenance locks and the filesystem-session cutover
// guard. Existing legacy databases remain rejected without modification.
const db = new CodeIndexDB(workerData.dbPath);
db.close();
parentPort.postMessage('database-ready');
parentPort.close();
