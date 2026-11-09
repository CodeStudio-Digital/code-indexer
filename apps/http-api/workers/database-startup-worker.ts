import { isAbsolute } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';

try {
  const dbPath = process.argv[2];
  if (!process.send || !dbPath || !isAbsolute(dbPath)) {
    throw new Error('database startup requires an absolute database path and a parent');
  }
  // Preserve maintenance locks and the filesystem-session cutover guard.
  // Legacy databases remain rejected without modification.
  const db = new CodeIndexDB(dbPath);
  db.close();
  process.send('database-ready', () => process.disconnect?.());
} catch (error) {
  process.exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  if (process.send) process.send({ error: message }, () => process.disconnect?.());
  else throw error;
}