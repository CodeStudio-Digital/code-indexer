import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideSeed,
  frontmatterToBuiltinUpsert,
  ensureBuiltinSkills,
  type EnsureBuiltinSkillsResult,
} from '@mcp/indexer/bootstrap/ensure-builtin-skills.js';
import type { SkillDefinition, UpsertSkillInput } from '@mcp/store/skill-store.js';

// ─── Test fixtures ───────────────────────────────────────────────

function makeExisting(partial: Partial<SkillDefinition>): SkillDefinition {
  return {
    id: 'qa-playwright',
    name: 'qa-playwright',
    description: '',
    slash_command: null,
    prompt_body: '',
    scope: 'global',
    enabled: true,
    allowed_tools: null,
    model_override: null,
    provider_override: null,
    context_mode: 'auto',
    variables: [],
    sort_order: 100,
    tags: [],
    path_patterns: null,
    trigger_paths: null,
    trigger_roles: null,
    author: 'mcp-builtin',
    version: '1.0.0',
    source: 'builtin',
    source_ref: null,
    created_at: '',
    updated_at: '',
    ...partial,
  };
}

function makeUpsert(version: string): UpsertSkillInput {
  return {
    id: 'qa-playwright',
    name: 'qa-playwright',
    prompt_body: '...',
    version,
    source: 'builtin',
  };
}

// ─── decideSeed ──────────────────────────────────────────────────

describe('decideSeed', () => {
  it('inserts when no existing row', () => {
    expect(decideSeed(null, makeUpsert('1.0.0'))).toEqual({ action: 'insert' });
  });

  it('updates when file version is newer', () => {
    const existing = makeExisting({ version: '1.0.0', source: 'builtin' });
    expect(decideSeed(existing, makeUpsert('1.1.0'))).toEqual({ action: 'update' });
  });

  it('skips when file version is the same', () => {
    const existing = makeExisting({ version: '1.0.0', source: 'builtin' });
    expect(decideSeed(existing, makeUpsert('1.0.0'))).toEqual({
      action: 'skip-same-version',
    });
  });

  it('skips when file version is older', () => {
    const existing = makeExisting({ version: '2.0.0', source: 'builtin' });
    expect(decideSeed(existing, makeUpsert('1.0.0'))).toEqual({
      action: 'skip-same-version',
    });
  });

  it('preserves user clones (source != builtin)', () => {
    const userClone = makeExisting({ source: 'user', version: '0.0.1' });
    expect(decideSeed(userClone, makeUpsert('99.0.0'))).toEqual({
      action: 'skip-user-clone',
    });
  });

  it('also preserves imported skills', () => {
    const imported = makeExisting({ source: 'imported', version: '0.0.1' });
    expect(decideSeed(imported, makeUpsert('99.0.0'))).toEqual({
      action: 'skip-user-clone',
    });
  });
});

// ─── frontmatterToBuiltinUpsert ──────────────────────────────────

describe('frontmatterToBuiltinUpsert', () => {
  it('uses frontmatter.name as id when present', () => {
    const out = frontmatterToBuiltinUpsert(
      { name: 'my-skill', description: 'desc', version: '2.0.0' },
      'body',
      'fallback',
    );
    expect(out.id).toBe('my-skill');
    expect(out.version).toBe('2.0.0');
    expect(out.source).toBe('builtin');
  });

  it('falls back to fallback id when name is missing', () => {
    const out = frontmatterToBuiltinUpsert({ description: 'x' }, 'body', 'qa-playwright');
    expect(out.id).toBe('qa-playwright');
  });

  it('passes allowed-tools through', () => {
    const out = frontmatterToBuiltinUpsert(
      { name: 's', 'allowed-tools': ['run_command', 'read_file'] },
      'body',
      'fallback',
    );
    expect(out.allowed_tools).toEqual(['run_command', 'read_file']);
  });

  it('defaults allowed-tools to null when missing', () => {
    const out = frontmatterToBuiltinUpsert({ name: 's' }, 'body', 'fallback');
    expect(out.allowed_tools).toBeNull();
  });

  it('coerces context-mode (auto/tool/both accepted; legacy "inline" maps to "auto")', () => {
    const auto = frontmatterToBuiltinUpsert({ name: 's', 'context-mode': 'auto' }, 'b', 'f');
    const tool = frontmatterToBuiltinUpsert({ name: 's', 'context-mode': 'tool' }, 'b', 'f');
    const both = frontmatterToBuiltinUpsert({ name: 's', 'context-mode': 'both' }, 'b', 'f');
    const inline = frontmatterToBuiltinUpsert({ name: 's', 'context-mode': 'inline' }, 'b', 'f');
    const bogus = frontmatterToBuiltinUpsert({ name: 's', 'context-mode': 'bogus' }, 'b', 'f');
    expect(auto.context_mode).toBe('auto');
    expect(tool.context_mode).toBe('tool');
    expect(both.context_mode).toBe('both');
    expect(inline.context_mode).toBe('auto'); // legacy v1 → coerced to 'auto'
    expect(bogus.context_mode).toBe('auto'); // default
  });

  it('reads nested trigger frontmatter (paths/roles/tags)', () => {
    const out = frontmatterToBuiltinUpsert(
      {
        name: 'ds-extractor',
        trigger: {
          paths: ['**/manifest.json', '**/source-inventory.json'],
          roles: ['extractor'],
          tags: ['design-system'],
        },
      } as Record<string, unknown>,
      'body',
      'fallback',
    );
    expect(out.trigger_paths).toEqual(['**/manifest.json', '**/source-inventory.json']);
    expect(out.trigger_roles).toEqual(['extractor']);
    // trigger.tags is folded into the tags column with a `trigger:` prefix
    expect(out.tags).toEqual(expect.arrayContaining(['trigger:design-system']));
  });

  it('falls back to flat trigger-paths/trigger-roles when "trigger" object is absent', () => {
    const out = frontmatterToBuiltinUpsert(
      {
        name: 'qa',
        'trigger-paths': ['**/*.spec.ts'],
        'trigger-roles': ['qa'],
      } as Record<string, unknown>,
      'b',
      'f',
    );
    expect(out.trigger_paths).toEqual(['**/*.spec.ts']);
    expect(out.trigger_roles).toEqual(['qa']);
  });

  it('coerces sort-order from string or number', () => {
    expect(
      frontmatterToBuiltinUpsert({ name: 's', 'sort-order': 10 }, 'b', 'f').sort_order,
    ).toBe(10);
    expect(
      frontmatterToBuiltinUpsert({ name: 's', 'sort-order': '20' }, 'b', 'f').sort_order,
    ).toBe(20);
    expect(
      frontmatterToBuiltinUpsert({ name: 's', 'sort-order': 'NaN' }, 'b', 'f').sort_order,
    ).toBe(50); // default
  });

  it('defaults version to 1.0.0 when missing', () => {
    expect(frontmatterToBuiltinUpsert({ name: 's' }, 'b', 'f').version).toBe('1.0.0');
  });
});

// ─── ensureBuiltinSkills (integration with in-memory store) ──────

interface InMemoryStore {
  rows: Map<string, SkillDefinition>;
  getSkill(id: string): SkillDefinition | null;
  upsertSkill(input: UpsertSkillInput): SkillDefinition;
}

function makeInMemoryStore(seed: SkillDefinition[] = []): InMemoryStore {
  const rows = new Map<string, SkillDefinition>(seed.map((s) => [s.id, s]));
  return {
    rows,
    getSkill(id) {
      return rows.get(id) ?? null;
    },
    upsertSkill(input) {
      const existing = rows.get(input.id);
      const next: SkillDefinition = {
        ...makeExisting({}),
        ...existing,
        id: input.id,
        name: input.name,
        prompt_body: input.prompt_body,
        version: input.version ?? '1.0.0',
        source: input.source ?? 'builtin',
      };
      rows.set(input.id, next);
      return next;
    },
  };
}

describe('ensureBuiltinSkills', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-builtin-skills-'));
  });

  function silentLogger() {
    return { log: () => {}, warn: () => {} };
  }

  it('inserts a fresh skill from a markdown file', () => {
    writeFileSync(
      join(dir, 'qa-playwright.md'),
      ['---', 'name: qa-playwright', 'description: hi', 'version: 1.0.0', '---', 'body'].join('\n'),
    );
    const store = makeInMemoryStore();
    const result = ensureBuiltinSkills(store, { builtinDir: dir, logger: silentLogger() });
    expect(result.inserted).toEqual(['qa-playwright']);
    expect(result.updated).toEqual([]);
    expect(store.rows.get('qa-playwright')?.version).toBe('1.0.0');
    rmSync(dir, { recursive: true, force: true });
  });

  it('is idempotent on re-run with same version', () => {
    writeFileSync(
      join(dir, 'qa.md'),
      ['---', 'name: qa', 'version: 1.0.0', '---', 'body'].join('\n'),
    );
    const store = makeInMemoryStore();
    ensureBuiltinSkills(store, { builtinDir: dir, logger: silentLogger() });
    const second = ensureBuiltinSkills(store, { builtinDir: dir, logger: silentLogger() });
    expect(second.inserted).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.skippedSameVersion).toEqual(['qa']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('updates when frontmatter version is newer than DB row', () => {
    writeFileSync(
      join(dir, 'qa.md'),
      ['---', 'name: qa', 'version: 2.0.0', '---', 'body v2'].join('\n'),
    );
    const store = makeInMemoryStore([
      makeExisting({ id: 'qa', name: 'qa', version: '1.0.0', source: 'builtin' }),
    ]);
    const result = ensureBuiltinSkills(store, { builtinDir: dir, logger: silentLogger() });
    expect(result.updated).toEqual(['qa']);
    expect(store.rows.get('qa')?.version).toBe('2.0.0');
    rmSync(dir, { recursive: true, force: true });
  });

  it('preserves user clones (different source)', () => {
    writeFileSync(
      join(dir, 'qa.md'),
      ['---', 'name: qa', 'version: 99.0.0', '---', 'body'].join('\n'),
    );
    const store = makeInMemoryStore([
      makeExisting({ id: 'qa', name: 'qa', version: '0.0.1', source: 'user' }),
    ]);
    const result = ensureBuiltinSkills(store, { builtinDir: dir, logger: silentLogger() });
    expect(result.skippedUserClone).toEqual(['qa']);
    expect(store.rows.get('qa')?.version).toBe('0.0.1'); // untouched
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses nested trigger frontmatter from a real markdown file', () => {
    writeFileSync(
      join(dir, 'ds-extractor.md'),
      [
        '---',
        'name: ds-extractor',
        'description: Extract DesignSystemManifestV2 from source-inventory shards.',
        'context-mode: auto',
        'trigger:',
        '  paths:',
        '    - "**/manifest.json"',
        '    - "**/source-inventory/**"',
        '  roles:',
        '    - extractor',
        '  tags:',
        '    - design-system',
        'allowed-tools:',
        '  - read_file',
        '  - ds_validate_manifest',
        'version: 2.0.0',
        '---',
        'body',
      ].join('\n'),
    );
    const store = makeInMemoryStore();
    ensureBuiltinSkills(store, { builtinDir: dir, logger: silentLogger() });

    const seeded = store.rows.get('ds-extractor')!;
    expect(seeded).toBeDefined();
    expect(seeded.version).toBe('2.0.0');
    rmSync(dir, { recursive: true, force: true });
  });

  it('records failures without throwing', () => {
    writeFileSync(join(dir, 'broken.md'), 'no frontmatter here');
    const store = makeInMemoryStore();
    const result: EnsureBuiltinSkillsResult = ensureBuiltinSkills(store, {
      builtinDir: dir,
      logger: silentLogger(),
    });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].file).toBe('broken.md');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty result when directory is missing', () => {
    const store = makeInMemoryStore();
    const result = ensureBuiltinSkills(store, {
      builtinDir: '/nonexistent/path-that-does-not-exist',
      logger: silentLogger(),
    });
    expect(result.inspected).toBe(0);
    expect(result.failed).toEqual([]);
  });
});
