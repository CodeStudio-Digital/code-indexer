import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '../store/db.js';

function mkFile(path: string) {
  return {
    path,
    language: 'typescript',
    size: 1,
    lineCount: 1,
    contentHash: 'h',
    summary: '',
    concepts: [],
    dependencies: [],
    internalDeps: [],
    externalDeps: [],
    notes: [],
    complexity: 'low',
  };
}

describe('Import resolver with tsconfig paths', () => {
  let dir: string;
  let db: CodeIndexDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-resolver-'));
    db = new CodeIndexDB(join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves relative imports with .ts extension', () => {
    const p = db.createProject('p', dir);
    const srcId = db.upsertFile(p.id, mkFile('src/a.ts'));
    db.upsertFile(p.id, mkFile('src/b.ts'));
    db.upsertFileDependencies(p.id, srcId, 'src/a.ts', ['./b'], []);
    const deps = db.getDependencies(srcId);
    expect(deps.some((d) => d.target_file_path === 'src/b.ts')).toBe(true);
  });

  it('resolves relative imports with .js extension (stripped)', () => {
    const p = db.createProject('p', dir);
    const srcId = db.upsertFile(p.id, mkFile('src/a.ts'));
    db.upsertFile(p.id, mkFile('src/b.ts'));
    db.upsertFileDependencies(p.id, srcId, 'src/a.ts', ['./b.js'], []);
    const deps = db.getDependencies(srcId);
    expect(deps.some((d) => d.target_file_path === 'src/b.ts')).toBe(true);
  });

  it('resolves index file imports', () => {
    const p = db.createProject('p', dir);
    const srcId = db.upsertFile(p.id, mkFile('src/a.ts'));
    db.upsertFile(p.id, mkFile('src/utils/index.ts'));
    db.upsertFileDependencies(p.id, srcId, 'src/a.ts', ['./utils'], []);
    const deps = db.getDependencies(srcId);
    expect(deps.some((d) => d.target_file_path === 'src/utils/index.ts')).toBe(true);
  });

  it('resolves tsconfig path aliases', () => {
    // Write tsconfig.json with @app/* alias
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@app/*': ['src/*'] },
        },
      })
    );

    const p = db.createProject('p', dir);
    const srcId = db.upsertFile(p.id, mkFile('src/a.ts'));
    db.upsertFile(p.id, mkFile('src/utils/helper.ts'));
    db.upsertFileDependencies(p.id, srcId, 'src/a.ts', ['@app/utils/helper'], []);
    const deps = db.getDependencies(srcId);
    expect(deps.some((d) => d.target_file_path === 'src/utils/helper.ts')).toBe(true);
  });

  it('tolerates JSONC comments in tsconfig.json', () => {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      `{
        // This is a comment
        "compilerOptions": {
          /* block comment */
          "baseUrl": ".",
          "paths": { "~/*": ["src/*"] }
        }
      }`
    );
    const p = db.createProject('p', dir);
    const srcId = db.upsertFile(p.id, mkFile('src/a.ts'));
    db.upsertFile(p.id, mkFile('src/lib/x.ts'));
    db.upsertFileDependencies(p.id, srcId, 'src/a.ts', ['~/lib/x'], []);
    const deps = db.getDependencies(srcId);
    expect(deps.some((d) => d.target_file_path === 'src/lib/x.ts')).toBe(true);
  });

  it('does not resolve bare module specifiers without matching alias', () => {
    const p = db.createProject('p', dir);
    const srcId = db.upsertFile(p.id, mkFile('src/a.ts'));
    db.upsertFileDependencies(p.id, srcId, 'src/a.ts', ['lodash'], ['lodash']);
    const deps = db.getDependencies(srcId);
    const internal = deps.find((d) => d.dep_type === 'internal');
    // import_path recorded but target is null
    expect(internal?.target_file_path).toBeNull();
  });
});
