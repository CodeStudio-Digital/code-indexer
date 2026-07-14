import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { relatedCodeSnippets } from '../completion/snippets/source-related-code.js';
import type { EngineInput } from '../completion/snippets/types.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

describe('context v3 related-code source', () => {
  it('recovers an analogous same-language window and respects exclusions/budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-ac-related-'));
    dirs.push(root);
    await mkdir(join(root, 'domain'), { recursive: true });
    await writeFile(join(root, 'domain', 'UserQuery.php'), `<?php\nclass UserQuery {\n  function find($textFilter) {\n    $cpf = applyMaskNumeric($textFilter);\n    return ['text_cpf' => $cpf];\n  }\n}\n`);
    const files = new Map([
      ['domain/UserQuery.php', { is_generated: 0 }],
      ['domain/Current.php', { is_generated: 0 }],
      ['domain/Generated.php', { is_generated: 1 }],
      ['domain/Other.ts', { is_generated: 0 }],
    ]);
    const db = {
      getProject: () => ({ root_path: root }),
      searchFileContents: () => [
        { id: 1, path: 'domain/Current.php', rank: -10 },
        { id: 2, path: 'domain/Generated.php', rank: -9 },
        { id: 3, path: 'domain/Other.ts', rank: -8 },
        { id: 4, path: 'domain/UserQuery.php', rank: -7 },
      ],
      getFile: (_projectId: number, path: string) => files.get(path),
    } as never;
    const input = {
      db, projectId: 1, file: 'domain/Current.php', language: 'php',
      windows: { prefix: '<?php\n$textFilter = $request->name;\n$cpf = applyMaskNumeric($textFilter);', suffix: '' },
      position: { line: 3, col: 1 }, budgetTokens: 1200, relatedCodeTokens: 80,
      sourceTimeoutMs: 100, deadlineMs: 150, cacheTtlMs: 1000, lspMemberRaceMs: 10,
      toggles: { recentEdits: false, openTabs: false, lspDefs: false, relatedCode: true },
      jaccardMinScore: 0.1, maxTabFiles: 3,
    } satisfies EngineInput;
    const snippets = await relatedCodeSnippets(input);
    expect(snippets).toHaveLength(1);
    expect(snippets[0]).toMatchObject({ kind: 'related-code', filePath: 'domain/UserQuery.php' });
    expect(snippets[0]!.content).toContain('applyMaskNumeric');
    expect(snippets[0]!.tokens).toBeLessThanOrEqual(80);
  });
});
