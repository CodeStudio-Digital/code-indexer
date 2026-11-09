import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundedGrep } from '../bounded-grep.js';

describe('bounded grep owner', () => {
  it('interrupts a pathological regex without blocking the host, then releases its slot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'grep-owner-'));
    try {
      writeFileSync(join(root, 'a.txt'), 'a'.repeat(500) + '!');
      let hostTick = false;
      const timer = setTimeout(() => { hostTick = true; }, 20);
      await expect(boundedGrep({ sources: [{ rootPath: root, prefix: '' }], paths: ['a.txt'], pattern: /^(a+)+$/, maxMatches: 5, timeoutMs: 200 })).rejects.toThrow('deadline');
      clearTimeout(timer);
      expect(hostTick).toBe(true);
      const result = await boundedGrep({ sources: [{ rootPath: root, prefix: '' }], paths: ['a.txt'], pattern: /!/, maxMatches: 5 });
      expect(result.matches).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('reports unreadable, oversized and omitted lines and prevents path escape', async () => {
    const root = mkdtempSync(join(tmpdir(), 'grep-bounds-'));
    try {
      writeFileSync(join(root, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
      writeFileSync(join(root, 'line.txt'), 'x'.repeat(2100));
      const result = await boundedGrep({ sources: [{ rootPath: root, prefix: '' }], paths: ['large.txt','line.txt','missing','../outside'], pattern: /x/, maxMatches: 5 });
      expect(result).toMatchObject({ skippedFiles: 3, skippedLines: 1, matches: [] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
