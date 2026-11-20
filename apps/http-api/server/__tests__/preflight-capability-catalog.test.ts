/**
 * Unit tests for the preflight capability catalog merge/cap logic. The
 * external enumerator and the skill store are injected as fakes, so no real
 * DB is opened (the module still loads @mcp/store transitively, so this suite
 * needs the better-sqlite3 ABI built for the test runner — `pnpm node:rebuild`).
 */
import { describe, expect, it } from 'vitest';
import type {
  SkillDefinition,
  SkillListFilter,
  SkillStore,
} from '@mcp/store/skill-store.js';
import {
  buildPreflightSkillCatalog,
} from '../preflight-capability-catalog.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('caps active skill suggestions at 30', () => {
    const out = buildPreflightSkillCatalog(
      fakeStore(Array.from({ length: 34 }, (_, i) => ({ id: `skill-${i}`, description: 'skill' }))),
      7,
    );
    expect(out).toHaveLength(30);
  });

  it('disables suggestions when the session explicitly selects no skills', () => {
    expect(buildPreflightSkillCatalog(fakeStore([{ id: 'a', description: 'x' }]), 7, [])).toEqual([]);
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
        dependencies: { '@corporate/charts': '3.1.0' },
      }));
      const store = {
        ...fakeStore([{
          id: 'charts-context',
          name: 'Chart library: @corporate/charts',
          description: 'Context for @corporate/charts',
          scope: 'global',
        }]),
      } as SkillStore;

      expect(buildPreflightSkillCatalog(store, 7, undefined, root)[0]).toMatchObject({
        id: 'charts-context',
        packageNames: ['@corporate/charts'],
        dependencyMatched: true,
        scope: 'global',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
