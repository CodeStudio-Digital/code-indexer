import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadRecentProjects, pushRecentProject } from '../recent-projects.js';

// The store reads `window.localStorage` at call time; vitest runs in the node
// environment (no window) so we install a Map-backed stub per test.
function installStorage(): void {
  const m = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    },
  };
}

describe('recent-projects MRU', () => {
  beforeEach(() => installStorage());
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('starts empty', () => {
    expect(loadRecentProjects()).toEqual([]);
  });

  it('keeps most-recent-first order', () => {
    pushRecentProject(1);
    pushRecentProject(2);
    pushRecentProject(3);
    expect(loadRecentProjects()).toEqual([3, 2, 1]);
  });

  it('dedupes — re-opening promotes to the front', () => {
    pushRecentProject(1);
    pushRecentProject(2);
    pushRecentProject(3);
    pushRecentProject(1);
    expect(loadRecentProjects()).toEqual([1, 3, 2]);
  });

  it('caps the list at 12 entries', () => {
    for (let id = 1; id <= 15; id += 1) pushRecentProject(id);
    const recent = loadRecentProjects();
    expect(recent).toHaveLength(12);
    expect(recent[0]).toBe(15); // newest first
    expect(recent).not.toContain(1); // oldest evicted
    expect(recent).not.toContain(3);
  });

  it('ignores non-finite ids', () => {
    pushRecentProject(Number.NaN);
    pushRecentProject(5);
    expect(loadRecentProjects()).toEqual([5]);
  });
});
