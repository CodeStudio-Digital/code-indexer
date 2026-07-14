import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { clearEditorConfigCache, resolveEditorConfig } from '../editorconfig.js';

const roots: string[] = [];
afterEach(async () => {
  clearEditorConfigCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('.editorconfig resolution', () => {
  it('merges hierarchical matching sections and invalidates changed configs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-editorconfig-'));
    roots.push(root);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, '.editorconfig'), 'root = true\n[*]\nindent_style = space\nindent_size = 2\ntrim_trailing_whitespace = true\n');
    await writeFile(join(root, 'src', '.editorconfig'), '[*.ts]\nindent_size = 4\nmax_line_length = 100\n');

    const first = await resolveEditorConfig(root, 'src/app.ts');
    expect(first.settings).toMatchObject({ insertSpaces: true, tabSize: 4, trimTrailingWhitespace: true, rulers: [100] });
    expect(first.sources).toEqual(['.editorconfig', 'src/.editorconfig']);

    await writeFile(join(root, 'src', '.editorconfig'), '[*.ts]\nindent_style = tab\nindent_size = 8\nmax_line_length = 120\n');
    const changed = await resolveEditorConfig(root, 'src/app.ts');
    expect(changed.settings).toMatchObject({ insertSpaces: false, tabSize: 8, rulers: [120] });
  });
});
