/**
 * Unit tests for the preflight capability catalog merge/cap logic. The
 * external enumerator and the skill store are injected as fakes, so no real
 * DB is opened (the module still loads @mcp/store transitively, so this suite
 * needs the better-sqlite3 ABI built for the test runner — `pnpm node:rebuild`).
 */
import { describe, expect, it, afterEach } from 'vitest';
import type { SkillStore } from '@mcp/store/skill-store.js';
import {
  buildPreflightToolCatalog,
  buildPreflightSkillCatalog,
} from '../preflight-capability-catalog.js';

const NATIVE = [
  { name: 'read_file', tier: 'bootstrap', description: 'read' },
  { name: 'edit_file', tier: 'navigate', description: 'edit' },
];

function fakeEnumerate(names: string[]): (dbPath: string) => { tools: any[]; details: any[] } {
  return () => ({
    tools: names.map((name) => ({ name, tier: 'srv', source: 'mcp_external', description: `${name} desc` })),
    details: [],
  });
}

const ENV_KEYS = ['CODER_PREFLIGHT_EXT_CATALOG_MAX', 'CODER_PREFLIGHT_SKILLS_MAX'] as const;
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('buildPreflightToolCatalog', () => {
  it('appends external tools after native, sorted by name', () => {
    const out = buildPreflightToolCatalog('db', NATIVE, fakeEnumerate(['ext_b__y', 'ext_a__x']));
    expect(out.map((t) => t.name)).toEqual(['read_file', 'edit_file', 'ext_a__x', 'ext_b__y']);
  });

  it('drops external tools whose name collides with a native one', () => {
    const out = buildPreflightToolCatalog('db', NATIVE, fakeEnumerate(['read_file', 'ext_a__x']));
    expect(out.filter((t) => t.name === 'read_file')).toHaveLength(1);
    expect(out.map((t) => t.name)).toContain('ext_a__x');
  });

  it('respects CODER_PREFLIGHT_EXT_CATALOG_MAX', () => {
    process.env.CODER_PREFLIGHT_EXT_CATALOG_MAX = '1';
    const out = buildPreflightToolCatalog('db', NATIVE, fakeEnumerate(['ext_a__x', 'ext_b__y']));
    expect(out.filter((t) => t.name.startsWith('ext_'))).toHaveLength(1);
  });

  it('honors 0 as show-none (hides all external tools)', () => {
    process.env.CODER_PREFLIGHT_EXT_CATALOG_MAX = '0';
    const out = buildPreflightToolCatalog('db', NATIVE, fakeEnumerate(['ext_a__x', 'ext_b__y']));
    expect(out).toEqual(NATIVE);
    expect(out.some((t) => t.name.startsWith('ext_'))).toBe(false);
  });

  it('fails open to the native catalog when enumeration throws', () => {
    const out = buildPreflightToolCatalog('db', NATIVE, () => { throw new Error('no db'); });
    expect(out).toEqual(NATIVE);
  });
});

describe('buildPreflightSkillCatalog', () => {
  function fakeStore(skills: Array<{ id: string; description: string; source?: string; author?: string | null }>): SkillStore {
    return {
      resolveActiveSkills: () =>
        skills.map((s) => ({
          id: s.id,
          name: s.id,
          description: s.description,
          source: s.source ?? 'builtin',
          author: s.author ?? null,
        })),
    } as unknown as SkillStore;
  }

  it('maps resolved skills to id + description + namespace', () => {
    const out = buildPreflightSkillCatalog(
      fakeStore([{ id: 'api-collection', description: 'API client' }]),
      1,
      7,
    );
    expect(out).toEqual([{ id: 'api-collection', description: 'API client', namespace: 'builtin' }]);
  });

  it('respects CODER_PREFLIGHT_SKILLS_MAX', () => {
    process.env.CODER_PREFLIGHT_SKILLS_MAX = '1';
    const out = buildPreflightSkillCatalog(
      fakeStore([
        { id: 'a', description: 'x' },
        { id: 'b', description: 'y' },
      ]),
      1,
      7,
    );
    expect(out).toHaveLength(1);
  });

  it('honors 0 as show-none (disables skill suggestions)', () => {
    process.env.CODER_PREFLIGHT_SKILLS_MAX = '0';
    expect(buildPreflightSkillCatalog(fakeStore([{ id: 'a', description: 'x' }]), 1, 7)).toEqual([]);
  });

  it('fails open to [] when the store throws', () => {
    const store = { resolveActiveSkills: () => { throw new Error('locked'); } } as unknown as SkillStore;
    expect(buildPreflightSkillCatalog(store, 1, 7)).toEqual([]);
  });
});
