import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { CodeIndexDB } from '@mcp/store/db.js';
import { relatedCodeSnippets } from '../completion/snippets/source-related-code.js';

// better-sqlite3 in the desktop checkout is built for Electron. The normal
// Node vitest run skips this; the Electron integration lane executes it.
const electronNativeAbi = process.versions.modules === '146';
const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

describe.runIf(electronNativeAbi)('context v3 temporary DB integration', () => {
  it('retrieves a hidden analogous file through file_contents_fts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-ac-db-'));
    roots.push(root);
    await mkdir(join(root, 'domain'), { recursive: true });
    const related = '<?php\nclass UserQuery { function run($textFilter) { return applyMaskNumeric($textFilter); } }';
    await writeFile(join(root, 'domain', 'UserQuery.php'), related);
    const db = new CodeIndexDB(join(root, 'index.db'));
    try {
      const project = db.createProject('fixture', root);
      const add = (path: string, content: string, generated = false) => {
        const id = db.upsertFile(project.id, {
          path, language: 'php', size: content.length, lineCount: content.split('\n').length,
          contentHash: path, dependencies: [], internalDeps: [], externalDeps: [],
          isGenerated: generated,
        });
        db.upsertFileContent(id, content, undefined, project.id);
      };
      add('domain/UserQuery.php', related);
      add('domain/Current.php', '<?php $textFilter = $request->name;');
      const snippets = await relatedCodeSnippets({
        db, projectId: project.id, file: 'domain/Current.php', language: 'php',
        windows: { prefix: '<?php\n$cpf = applyMaskNumeric($textFilter);', suffix: '' },
        position: { line: 2, col: 1 }, budgetTokens: 1200, relatedCodeTokens: 700,
        sourceTimeoutMs: 100, deadlineMs: 150, cacheTtlMs: 1000, lspMemberRaceMs: 10,
        toggles: { recentEdits: false, openTabs: false, lspDefs: false, relatedCode: true },
        jaccardMinScore: 0.1, maxTabFiles: 3,
      });
      expect(snippets.map((s) => s.filePath)).toContain('domain/UserQuery.php');
    } finally { db.close(); }
  });
});
