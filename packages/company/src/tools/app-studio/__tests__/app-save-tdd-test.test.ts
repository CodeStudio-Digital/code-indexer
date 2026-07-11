import { describe, expect, it } from 'vitest';
import { databaseTestContractIssue } from '../app-save-tdd-test.js';

describe('database TDD test contract', () => {
  it('rejects source-file inspection as database evidence', () => {
    expect(databaseTestContractIssue(`
      import { readFileSync } from 'node:fs';
      const sql = readFileSync(process.cwd() + '/migrations/0001.sql', 'utf8');
    `)).toContain('isolated D1 binding');
  });

  it('accepts assertions that query the isolated D1 binding', () => {
    expect(databaseTestContractIssue(`
      import { env } from 'cloudflare:workers';
      const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM users').first();
    `)).toBeNull();
  });
});
