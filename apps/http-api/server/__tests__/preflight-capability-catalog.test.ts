/**
 * Unit tests for the preflight capability catalog merge/cap logic. The
 * external enumerator and the skill store are injected as fakes, so no real
 * DB is opened (the module still loads @mcp/store transitively, so this suite
 * needs the better-sqlite3 ABI built for the test runner — `pnpm node:rebuild`).
 */
import { describe, expect, it, afterEach } from 'vitest';
import type {
  SkillDefinition,
  SkillListFilter,
  SkillStore,
} from '@mcp/store/skill-store.js';
import {
  buildPreflightToolCatalog,
  buildPreflightSkillCatalog,
} from '../preflight-capability-catalog.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  function fakeStore(
    skills: Array<{
      id: string;
      description: string;
      source?: string;
      author?: string | null;
      enabled?: boolean;
      scope?: string;
      name?: string;
    }>,
  ): SkillStore {
    const definitions = skills.map((skill): SkillDefinition => ({
      id: skill.id,
      name: skill.name ?? skill.id,
      description: skill.description,
      slash_command: null,
      prompt_body: '',
      scope: skill.scope ?? 'global',
      enabled: skill.enabled ?? true,
      allowed_tools: null,
      model_override: null,
      provider_override: null,
      context_mode: 'auto',
      variables: [],
      sort_order: 0,
      tags: [],
      path_patterns: null,
      trigger_paths: null,
      trigger_roles: null,
      author: skill.author ?? null,
      version: '1',
      source: (skill.source ?? 'builtin') as SkillDefinition['source'],
      source_ref: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }));
    return {
      listSkills: (filter?: SkillListFilter) =>
        definitions.filter(
          (skill) =>
            filter?.scope == null || skill.scope === filter.scope,
        ),
      getSkill: (id: string) =>
        definitions.find((skill) => skill.id === id) ?? null,
    } as unknown as SkillStore;
  }

  it('maps resolved skills to id + description + namespace', () => {
    const out = buildPreflightSkillCatalog(
      fakeStore([{ id: 'api-collection', description: 'API client' }]),
      7,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'api-collection',
      name: 'api-collection',
      description: 'API client',
      namespace: 'builtin',
      dependencyMatched: false,
    });
  });

  it('respects CODER_PREFLIGHT_SKILLS_MAX', () => {
    process.env.CODER_PREFLIGHT_SKILLS_MAX = '1';
    const out = buildPreflightSkillCatalog(
      fakeStore([
        { id: 'a', description: 'x' },
        { id: 'b', description: 'y' },
      ]),
      7,
    );
    expect(out).toHaveLength(1);
  });

  it('honors 0 as show-none (disables skill suggestions)', () => {
    process.env.CODER_PREFLIGHT_SKILLS_MAX = '0';
    expect(buildPreflightSkillCatalog(fakeStore([{ id: 'a', description: 'x' }]), 7)).toEqual([]);
  });

  it('uses the filesystem active-skill projection instead of session SQLite overrides', () => {
    const out = buildPreflightSkillCatalog(
      fakeStore([
        { id: 'default-on', description: 'default', enabled: true },
        { id: 'selected', description: 'selected', enabled: false },
      ]),
      7,
      ['selected'],
    );

    expect(out.map((skill) => skill.id)).toEqual(['selected']);
  });

  it('fails open to [] when the store throws', () => {
    const store = { listSkills: () => { throw new Error('locked'); } } as unknown as SkillStore;
    expect(buildPreflightSkillCatalog(store, 7)).toEqual([]);
  });

  it('records package dependency evidence without auto-selecting the skill', () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-skill-dep-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        dependencies: { '@corporate/ui': '3.1.0' },
      }));
      const store = {
        ...fakeStore([{
          id: 'ds-ctx-ui',
          name: 'Design System: @corporate/ui',
          description: 'Context for @corporate/ui',
          scope: 'global',
        }]),
      } as SkillStore;

      expect(buildPreflightSkillCatalog(store, 7, undefined, root)[0]).toMatchObject({
        id: 'ds-ctx-ui',
        packageNames: ['@corporate/ui'],
        dependencyMatched: true,
        scope: 'global',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
