import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { APP_STUDIO_DIRNAME } from '../status-files.js';
import { sqlHasStatements } from '../verification/workspace-checks.js';

function withoutLeadingComments(statement: string): string {
  return statement.replace(/^(?:\s*--[^\n]*(?:\n|$)|\s*\/\*[\s\S]*?\*\/\s*)+/, '').trim();
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let state: 'normal' | 'single' | 'double' | 'backtick' | 'bracket' | 'line-comment' | 'block-comment' = 'normal';
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];
    if (state === 'line-comment') {
      if (char === '\n') state = 'normal';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'normal';
        i += 1;
      }
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'backtick') {
      const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
      if (char === quote && next === quote) i += 1;
      else if (char === quote) state = 'normal';
      continue;
    }
    if (state === 'bracket') {
      if (char === ']') state = 'normal';
      continue;
    }
    if (char === '-' && next === '-') {
      state = 'line-comment';
      i += 1;
    } else if (char === '/' && next === '*') {
      state = 'block-comment';
      i += 1;
    } else if (char === "'") state = 'single';
    else if (char === '"') state = 'double';
    else if (char === '`') state = 'backtick';
    else if (char === '[') state = 'bracket';
    else if (char === ';') {
      statements.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  statements.push(sql.slice(start));
  return statements.map(withoutLeadingComments).filter(Boolean);
}

export function validateAppSeedSql(sql: string): string | null {
  if (!sqlHasStatements(sql)) return 'seed sql must contain at least one INSERT statement.';
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) return 'seed sql must contain at least one INSERT statement.';
  for (const statement of statements) {
    if (!/^INSERT\s+OR\s+IGNORE\b/i.test(statement) && !(/^INSERT\b/i.test(statement) && /\bON\s+CONFLICT\b/i.test(statement))) {
      return 'every seed statement must use INSERT OR IGNORE or ON CONFLICT so retries cannot duplicate data.';
    }
  }
  return null;
}

export function appSeedHash(workspaceDir: string): string | null {
  const path = join(workspaceDir, 'seeds', 'seed.sql');
  if (!existsSync(path)) return null;
  try {
    const contents = readFileSync(path, 'utf8');
    return sqlHasStatements(contents) ? createHash('sha256').update(contents).digest('hex') : null;
  } catch {
    return null;
  }
}

export interface ReplaceAppSeedResult {
  changed: boolean;
  seed_path: string;
  backup_path: string | null;
  hash: string;
}

export function replaceAppSeedFile(workspaceDir: string, sql: string): ReplaceAppSeedResult {
  const issue = validateAppSeedSql(sql);
  if (issue) throw new Error(issue);
  const normalized = `${sql.trim().replace(/\r\n/g, '\n')}\n`;
  const seedDir = join(workspaceDir, 'seeds');
  const seedPath = join(seedDir, 'seed.sql');
  mkdirSync(seedDir, { recursive: true });
  let current = '';
  try { current = readFileSync(seedPath, 'utf8'); } catch { /* first canonical seed */ }
  const hash = createHash('sha256').update(normalized).digest('hex');
  if (current === normalized) return { changed: false, seed_path: seedPath, backup_path: null, hash };

  let backupPath: string | null = null;
  if (current && existsSync(seedPath)) {
    const backupDir = join(workspaceDir, APP_STUDIO_DIRNAME, 'backups');
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = join(backupDir, `seed-${stamp}.sql`);
    copyFileSync(seedPath, backupPath);
  }
  writeFileSync(seedPath, normalized, 'utf8');
  return { changed: true, seed_path: seedPath, backup_path: backupPath, hash };
}
