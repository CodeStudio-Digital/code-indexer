/**
 * Regression: a deleted file (or an indexer-internal `.mcp-indexer/` scratch
 * file) must NOT make `getDiagnostics` spam "Could not find source file" on
 * every diagnostics poll. The service now self-heals — it prunes the stale
 * root and returns `[]` without invoking the language service, and refuses to
 * track anything under `.mcp-indexer/`.
 *
 * Origin: doc-indexer wrote `.mcp-indexer/trash/<ts>/.tmp/*.cjs`, deleted them,
 * and the 1 s LSP poll then logged the warning forever.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TsLanguageService } from '../ts-service.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ts-prune-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('TsLanguageService — self-heal on missing / indexer-internal files', () => {
  it('prunes a deleted file and stops warning on getDiagnostics', () => {
    writeFileSync(join(root, 'a.ts'), 'export const a: number = 1;\n');
    const svc = new TsLanguageService(root);

    // First call tracks + diagnoses the real file (no throw).
    expect(() => svc.getDiagnostics('a.ts')).not.toThrow();

    // File vanishes (deleted / moved to trash).
    unlinkSync(join(root, 'a.ts'));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Two consecutive polls — must return clean and emit no
      // "getDiagnostics: Could not find source file" warnings.
      expect(svc.getDiagnostics('a.ts')).toEqual([]);
      expect(svc.getDiagnostics('a.ts')).toEqual([]);
      const noisy = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('[lsp] getDiagnostics:'));
      expect(noisy).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('never tracks or diagnoses files under .mcp-indexer/, even if they exist', () => {
    // A real, on-disk scratch file that would otherwise parse fine.
    const trashDir = join(root, '.mcp-indexer', 'trash', 'x', '.tmp');
    mkdirSync(trashDir, { recursive: true });
    writeFileSync(join(trashDir, 'asaas-docs-extract.cjs'), 'const x = 1;\n');
    writeFileSync(join(root, 'real.ts'), 'export const r: number = 1;\n');

    const svc = new TsLanguageService(root);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rel = '.mcp-indexer/trash/x/.tmp/asaas-docs-extract.cjs';
      expect(svc.getDiagnostics(rel)).toEqual([]);
      // The scratch file must not have polluted the program — a real file
      // still diagnoses without throwing.
      expect(() => svc.getDiagnostics('real.ts')).not.toThrow();
      const noisy = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('[lsp]'));
      expect(noisy).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
