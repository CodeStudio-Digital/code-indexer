/**
 * Regression: the indexer's own private working dir (`.mcp-indexer/`, which
 * holds the trash bin + `.tmp` scratch files) must be ignored by the scanner.
 * Without this, the doc-indexer's `.mcp-indexer/trash/<ts>/.tmp/*.cjs` files
 * get indexed and fed to the LSP, which then loops on "Could not find source
 * file" once they're deleted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildScannerIgnore, GLOB_PRUNE_DIRS } from '../scanner-ignore.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scan-ignore-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('scanner ignore — .mcp-indexer', () => {
  it('ignores trash + .tmp scratch files under .mcp-indexer', () => {
    const ig = buildScannerIgnore(root, [], () => false);
    expect(ig.ignores('.mcp-indexer/trash/2026-06-02T0/.tmp/asaas-docs-extract.cjs')).toBe(true);
    expect(ig.ignores('.mcp-indexer/cache/foo.json')).toBe(true);
    // Real source is still scanned.
    expect(ig.ignores('src/index.ts')).toBe(false);
  });

  it('hard-prunes the .mcp-indexer directory in the glob walk', () => {
    expect(GLOB_PRUNE_DIRS).toContain('.mcp-indexer');
  });
});
