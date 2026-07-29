import { resolve } from 'node:path';
import type { CliOptions, MigrationMode } from './model.js';

const USAGE = `Usage:
  pnpm sessions:fs-migrate -- --dry-run [--db PATH] [--data-dir PATH] [--json]
  pnpm sessions:fs-migrate -- --apply --delete-source-db [--db PATH] [--data-dir PATH] [--json]
  pnpm sessions:fs-migrate -- --verify-only [--db PATH] [--data-dir PATH] [--json]

This is an offline, big-bang migration. --apply is accepted only together with
--delete-source-db; there is no dual-write, fallback, or compatibility mode.`;

export class CliUsageError extends Error {
  constructor(message: string) {
    super(`${message}\n\n${USAGE}`);
    this.name = 'CliUsageError';
  }
}

function takeValue(args: string[], index: number, flag: string): [string, number] {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new CliUsageError(`${flag} requires a path`);
  }
  return [resolve(value), index + 1];
}

export function parseCliArgs(args: readonly string[]): CliOptions {
  let mode: MigrationMode | undefined;
  let deleteSourceDb = false;
  let dbPath: string | undefined;
  let dataDir: string | undefined;
  let json = false;

  const mutable = [...args];
  for (let i = 0; i < mutable.length; i++) {
    const arg = mutable[i];
    switch (arg) {
      case '--dry-run':
        if (mode) throw new CliUsageError('choose exactly one operation');
        mode = 'dry-run';
        break;
      case '--apply':
        if (mode) throw new CliUsageError('choose exactly one operation');
        mode = 'apply';
        break;
      case '--verify-only':
        if (mode) throw new CliUsageError('choose exactly one operation');
        mode = 'verify-only';
        break;
      case '--delete-source-db':
        deleteSourceDb = true;
        break;
      case '--db': {
        [dbPath, i] = takeValue(mutable, i, arg);
        break;
      }
      case '--data-dir': {
        [dataDir, i] = takeValue(mutable, i, arg);
        break;
      }
      case '--json':
        json = true;
        break;
      case '--help':
      case '-h':
        throw new CliUsageError('');
      default:
        throw new CliUsageError(`unknown argument: ${arg}`);
    }
  }

  if (!mode) throw new CliUsageError('an operation is required');
  if (mode === 'apply' && !deleteSourceDb) {
    throw new CliUsageError('--apply requires the explicit --delete-source-db acknowledgement');
  }
  if (mode !== 'apply' && deleteSourceDb) {
    throw new CliUsageError('--delete-source-db is valid only with --apply');
  }

  return { mode, deleteSourceDb, dbPath, dataDir, json };
}

export { USAGE };

