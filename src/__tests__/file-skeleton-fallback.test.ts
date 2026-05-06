import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '../store/db.js';
import { fileTools } from '../apps/mcp-server/tools/file.js';

const get_file_skeleton = fileTools.find((t) => t.name === 'get_file_skeleton')!;
const get_file_structure = fileTools.find((t) => t.name === 'get_file_structure')!;
const list_directory = fileTools.find((t) => t.name === 'list_directory')!;
const read_file = fileTools.find((t) => t.name === 'read_file')!;

describe('get_file_skeleton — tree-sitter fallback for non-indexed files', () => {
  let workDir: string;
  let dbPath: string;
  let db: CodeIndexDB;
  let projectId: number;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'gfs-'));
    mkdirSync(join(workDir, 'src', 'app', 'elementos', 'receita'), { recursive: true });
    writeFileSync(
      join(workDir, 'src', 'app', 'elementos', 'receita', 'receita.component.ts'),
      [
        "import { Component, Input } from '@angular/core';",
        '',
        '@Component({ selector: "app-receita" })',
        'export class ReceitaComponent {',
        '  @Input() titulo = "";',
        '  ingredientes: string[] = [];',
        '',
        '  adicionarIngrediente(nome: string): void {',
        '    if (!nome) return;',
        '    this.ingredientes.push(nome);',
        '  }',
        '',
        '  remover(idx: number): boolean {',
        '    return this.ingredientes.splice(idx, 1).length > 0;',
        '  }',
        '}',
        '',
        'export interface Receita {',
        '  titulo: string;',
        '  passos: string[];',
        '}',
        '',
      ].join('\n'),
    );

    dbPath = join(workDir, 'index.sqlite');
    db = new CodeIndexDB(dbPath);
    // Register the project but do NOT index it — files table is empty.
    const project = db.createProject('test-proj', workDir);
    projectId = project.id;
  });

  afterAll(() => {
    db.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns a tree-sitter skeleton for a file the DB does not know about', async () => {
    const ctx = { db } as unknown as Parameters<typeof get_file_skeleton.handler>[1];
    const out = await get_file_skeleton.handler(
      {
        project_name: 'test-proj',
        file_path: 'src/app/elementos/receita/receita.component.ts',
      },
      ctx,
    );
    const text = String(out);
    expect(text).toContain('tree-sitter fallback');
    expect(text).toContain('ReceitaComponent');
    expect(text).toContain('adicionarIngrediente');
    expect(text).toContain('Receita');
  });

  it('returns JSON with source=tree-sitter-fallback when format=json', async () => {
    const ctx = { db } as unknown as Parameters<typeof get_file_skeleton.handler>[1];
    const out = await get_file_skeleton.handler(
      {
        project_name: 'test-proj',
        file_path: 'src/app/elementos/receita/receita.component.ts',
        format: 'json',
      },
      ctx,
    );
    const parsed = JSON.parse(String(out));
    expect(parsed.source).toBe('tree-sitter-fallback');
    expect(parsed.total_symbols).toBeGreaterThan(0);
    const names = (parsed.symbols as Array<{ name: string }>).map((s) => s.name);
    expect(names).toContain('ReceitaComponent');
    expect(names).toContain('adicionarIngrediente');
  });

  it('still throws when the file does not exist on disk', async () => {
    const ctx = { db } as unknown as Parameters<typeof get_file_skeleton.handler>[1];
    await expect(
      get_file_skeleton.handler(
        { project_name: 'test-proj', file_path: 'does/not/exist.ts' },
        ctx,
      ),
    ).rejects.toThrow(/not found in index nor on disk/);
  });

  it('get_file_structure also falls back to tree-sitter', async () => {
    const ctx = { db } as unknown as Parameters<typeof get_file_structure.handler>[1];
    const out = await get_file_structure.handler(
      {
        project_name: 'test-proj',
        file_path: 'src/app/elementos/receita/receita.component.ts',
      },
      ctx,
    );
    const text = String(out);
    expect(text).toContain('tree-sitter fallback');
    expect(text).toContain('ReceitaComponent');
  });

  it('list_directory falls back to disk when the index is empty', async () => {
    const ctx = { db } as unknown as Parameters<typeof list_directory.handler>[1];
    const out = await list_directory.handler(
      { project_name: 'test-proj', path: 'src/app/elementos/receita', depth: 1 },
      ctx,
    );
    const text = String(out);
    expect(text).toContain('disk fallback');
    expect(text).toContain('receita.component.ts');
  });

  it('list_directory disk fallback skips ignored dirs', async () => {
    const ctx = { db } as unknown as Parameters<typeof list_directory.handler>[1];
    const out = await list_directory.handler(
      { project_name: 'test-proj', path: '', depth: 2 },
      ctx,
    );
    expect(String(out)).not.toContain('node_modules');
    expect(String(out)).not.toContain('.git');
  });

  it('read_file falls back to disk for a non-indexed file', async () => {
    const ctx = { db } as unknown as Parameters<typeof read_file.handler>[1];
    const out = await read_file.handler(
      { project_name: 'test-proj', file_path: 'src/app/elementos/receita/receita.component.ts', max_lines: 5 },
      ctx,
    );
    const text = String(out);
    expect(text).toContain('disk fallback');
    expect(text).toContain('ReceitaComponent');
  });

  it('read_file errors clearly when path is a directory', () => {
    const ctx = { db } as unknown as Parameters<typeof read_file.handler>[1];
    expect(() =>
      read_file.handler(
        { project_name: 'test-proj', file_path: 'src/app/elementos/receita' },
        ctx,
      ),
    ).toThrow(/is a directory/);
  });

  it('read_file errors clearly when path does not exist on disk', () => {
    const ctx = { db } as unknown as Parameters<typeof read_file.handler>[1];
    expect(() =>
      read_file.handler(
        { project_name: 'test-proj', file_path: 'does/not/exist.ts' },
        ctx,
      ),
    ).toThrow(/not found in index nor on disk/);
  });

  it('skeleton fallback handles .scss via tree-sitter (CSS grammar reuse)', async () => {
    // Inject a small SCSS file into the temp project root.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const wd = (db.getProject(projectId)?.root_path ?? '') as string;
    fs.mkdirSync(path.join(wd, 'styles'), { recursive: true });
    fs.writeFileSync(
      path.join(wd, 'styles', 'card.scss'),
      [
        '.card {',
        '  padding: 8px;',
        '}',
        '.card__header {',
        '  font-weight: 600;',
        '}',
        '#main-cta {',
        '  color: red;',
        '}',
        '@keyframes spin {',
        '  from { transform: rotate(0); }',
        '  to   { transform: rotate(360deg); }',
        '}',
      ].join('\n'),
    );

    const ctx = { db } as unknown as Parameters<typeof get_file_skeleton.handler>[1];
    const out = await get_file_skeleton.handler(
      { project_name: 'test-proj', file_path: 'styles/card.scss' },
      ctx,
    );
    const text = String(out);
    expect(text).toContain('tree-sitter fallback');
    // Top-level selectors come through (selectors text is the symbol name).
    expect(text).toContain('.card');
    expect(text).toContain('#main-cta');
    // At-rule (keyframes) shows up as a function-kind entry.
    expect(text.toLowerCase()).toContain('@keyframes');
  });
});
