import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliUsageError, parseCliArgs } from '../cli.js';

describe('sessions filesystem migration CLI', () => {
  it('parses each operation and resolves explicit paths', () => {
    expect(parseCliArgs(['--dry-run']).mode).toBe('dry-run');
    expect(parseCliArgs(['--verify-only', '--json'])).toMatchObject({
      mode: 'verify-only',
      json: true,
      deleteSourceDb: false,
    });
    expect(parseCliArgs([
      '--apply',
      '--delete-source-db',
      '--db',
      './data/index.db',
      '--data-dir',
      './data',
    ])).toMatchObject({
      mode: 'apply',
      deleteSourceDb: true,
      dbPath: resolve('./data/index.db'),
      dataDir: resolve('./data'),
    });
  });

  it('requires one operation and the irreversible apply acknowledgement', () => {
    expect(() => parseCliArgs([])).toThrow(CliUsageError);
    expect(() => parseCliArgs(['--apply'])).toThrow('--apply requires');
    expect(() => parseCliArgs(['--dry-run', '--delete-source-db'])).toThrow(
      '--delete-source-db is valid only with --apply',
    );
    expect(() => parseCliArgs(['--dry-run', '--verify-only'])).toThrow(
      'choose exactly one operation',
    );
  });

  it('rejects unknown options and missing path values', () => {
    expect(() => parseCliArgs(['--dry-run', '--unknown'])).toThrow('unknown argument');
    expect(() => parseCliArgs(['--dry-run', '--db'])).toThrow('--db requires a path');
  });
});
