import { describe, expect, it, vi } from 'vitest';
import { searchProjectsConcurrently } from '../search-global.js';

const projects = Array.from({ length: 9 }, (_, index) => ({
  id: index + 1,
  name: `project-${index + 1}`,
}));

describe('searchProjectsConcurrently', () => {
  it('caps fan-out at four and preserves project order', async () => {
    let active = 0;
    let peak = 0;
    const release = new Map<number, () => void>();

    const pending = searchProjectsConcurrently(
      projects,
      async (project) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => release.set(project.id, resolve));
        active -= 1;
        return `result-${project.id}`;
      },
      20,
    );

    await vi.waitFor(() => expect(release.size).toBe(4));
    release.get(4)?.();
    await vi.waitFor(() => expect(release.size).toBe(5));
    release.get(2)?.();
    await vi.waitFor(() => expect(release.size).toBe(6));
    release.get(1)?.();
    await vi.waitFor(() => expect(release.size).toBe(7));
    release.get(3)?.();
    await vi.waitFor(() => expect(release.size).toBe(8));
    release.get(8)?.();
    await vi.waitFor(() => expect(release.size).toBe(9));
    for (const id of [5, 6, 7, 9]) release.get(id)?.();

    const results = await pending;
    expect(peak).toBe(4);
    expect(results.map((result) => result.project.id)).toEqual(projects.map((project) => project.id));
    expect(results.map((result) => result.results)).toEqual(
      projects.map((project) => `result-${project.id}`),
    );
  });

  it('keeps other project results when one search fails', async () => {
    const results = await searchProjectsConcurrently(projects.slice(0, 3), async (project) => {
      if (project.id === 2) throw new Error('database unavailable');
      return [project.name];
    });

    expect(results[0]).toMatchObject({ error: null, results: ['project-1'] });
    expect(results[1]?.results).toBeNull();
    expect(results[1]?.error).toEqual(new Error('database unavailable'));
    expect(results[2]).toMatchObject({ error: null, results: ['project-3'] });
  });
});
