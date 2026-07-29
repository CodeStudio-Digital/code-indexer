#!/usr/bin/env tsx
import { runSessionsFsMigrationCli } from './sessions-fs-migrate/run.js';

runSessionsFsMigrationCli(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[sessions-fs-migrate] FATAL: ${message}\n`);
  process.exitCode = 1;
});
