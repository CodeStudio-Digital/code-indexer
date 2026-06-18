/**
 * W2/P3 — cache TTL do fast path de files.tree. Puro, `now` injetado (determinístico).
 */
import { describe, it, expect } from 'vitest';
import type { FileTreeNode } from '@mcp/api-bus';
import { createDirCache } from '../dir-cache.js';

const node = (p: string): FileTreeNode => ({ name: p || '.', path: p, type: 'dir', children: [] });

describe('createDirCache', () => {
  it('expira por TTL', () => {
    let t = 0;
    const c = createDirCache({ ttlMs: 100, now: () => t });
    c.set(1, 'src', node('src'));
    t = 50;
    expect(c.get(1, 'src')).toBeDefined();
    t = 200;
    expect(c.get(1, 'src')).toBeUndefined();
  });

  it('invalidate limpa o dir E o parent (entry nova muda a listagem do parent)', () => {
    const c = createDirCache({ now: () => 0 });
    c.set(1, '', node(''));
    c.set(1, 'src', node('src'));
    c.invalidate(1, 'src/new.ts');
    expect(c.get(1, 'src')).toBeUndefined();
  });

  it('invalidate de um dir limpa descendentes cacheados', () => {
    const c = createDirCache({ now: () => 0 });
    c.set(1, 'src', node('src'));
    c.set(1, 'src/a', node('src/a'));
    c.set(1, 'src/a/b', node('src/a/b'));
    c.invalidate(1, 'src');
    expect(c.get(1, 'src/a')).toBeUndefined();
    expect(c.get(1, 'src/a/b')).toBeUndefined();
  });

  it('colapsa chave "." e ""', () => {
    const c = createDirCache({ now: () => 0 });
    c.set(1, '.', node(''));
    expect(c.get(1, '')).toBeDefined();
  });

  it('isola por projectId', () => {
    const c = createDirCache({ now: () => 0 });
    c.set(1, 'src', node('src'));
    expect(c.get(2, 'src')).toBeUndefined();
  });
});
