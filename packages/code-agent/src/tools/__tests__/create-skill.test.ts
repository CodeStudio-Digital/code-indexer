/**
 * Tests for the create_skill tool + its deterministic trigger eval.
 *
 * Covers: id validation, dry_run NOT persisting, create-then-update by id,
 * unknown allowed_tools warning, and the trigger eval firing + collision /
 * discovery-only reporting.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SkillStore } from '@mcp/store/skill-store.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ResolvedSkill } from '@mcp/code-agent/skills/types.js';
import { buildCreateSkillTool } from '../create-skill.js';
import { evalSkillTriggers } from '../skill-trigger-eval.js';

const CTX = {} as ToolContext; // handler ignores ctx

function nativeTool(name: string): CoderTool {
  return {
    name,
    description: name,
    source: 'native',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ content: '' }),
  };
}

function resolved(partial: Partial<ResolvedSkill> & { id: string }): ResolvedSkill {
  return {
    id: partial.id,
    name: partial.name ?? partial.id,
    description: partial.description ?? '',
    slashCommand: partial.slashCommand ?? null,
    promptBody: partial.promptBody ?? 'body',
    allowedTools: partial.allowedTools ?? null,
    modelOverride: null,
    providerOverride: null,
    contextMode: partial.contextMode ?? 'auto',
    pathPatterns: null,
    triggerPaths: partial.triggerPaths ?? null,
    triggerRoles: partial.triggerRoles ?? null,
    triggerTags: partial.triggerTags ?? null,
    tags: partial.tags ?? [],
    source: 'user',
    author: null,
    sortOrder: partial.sortOrder ?? 0,
  };
}

describe('evalSkillTriggers', () => {
  it('flags a discovery-only skill (no triggers)', () => {
    const r = evalSkillTriggers(resolved({ id: 'a' }), []);
    expect(r.discoveryOnly).toBe(true);
    expect(r.fires).toBe(false);
  });

  it('reports the skill firing on its own path trigger', () => {
    const r = evalSkillTriggers(resolved({ id: 'tsx', triggerPaths: ['**/*.test.ts'] }), []);
    expect(r.discoveryOnly).toBe(false);
    expect(r.fires).toBe(true);
    expect(r.results[0].candidateFired).toBe(true);
  });

  it('detects a collision with an existing skill on the same context', () => {
    const existing = [resolved({ id: 'other', triggerPaths: ['**/*.ts'] })];
    const r = evalSkillTriggers(resolved({ id: 'mine', triggerPaths: ['**/*.test.ts'] }), existing);
    const ctx = r.results[0];
    expect(ctx.candidateFired).toBe(true);
    expect(ctx.collisions.map((c) => c.id)).toContain('other');
  });
});

describe('create_skill tool', () => {
  let dir: string;
  let dbPath: string;
  let tool: CoderTool;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-create-skill-'));
    dbPath = join(dir, 'test.db');
    const db = new CodeIndexDB(dbPath);
    // @ts-expect-error - internal handle for fixture setup
    db.db.prepare(`INSERT INTO projects (id, name, root_path, created_at) VALUES (1, 'p', '/p', datetime('now'))`).run();
    db.close();

    const registry = new ToolRegistry();
    registry.register(nativeTool('read_file'));
    registry.register(nativeTool('write_file'));
    tool = buildCreateSkillTool({ dbPath, registry, projectId: 1 });
  });

  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  it('rejects an invalid id', async () => {
    const res = await tool.handler({ id: 'Bad Id', name: 'x', description: 'd', prompt_body: 'b' }, CTX);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/invalid id/i);
  });

  it('dry_run validates and does NOT persist', async () => {
    const res = await tool.handler(
      { id: 'my-skill', name: 'My Skill', description: 'd', prompt_body: 'b', dry_run: true },
      CTX,
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatch(/dry run/i);
    const store = new SkillStore(dbPath);
    expect(store.getSkill('my-skill')).toBeNull();
    store.close();
  });

  it('persists on a real call and updates when the id is reused', async () => {
    await tool.handler(
      { id: 'my-skill', name: 'My Skill', description: 'first', prompt_body: 'b', slash_command: 'mys' },
      CTX,
    );
    const store = new SkillStore(dbPath);
    const created = store.getSkill('my-skill');
    expect(created?.slash_command).toBe('mys');
    expect(created?.description).toBe('first');
    store.close();

    await tool.handler(
      { id: 'my-skill', name: 'My Skill', description: 'second', prompt_body: 'b2' },
      CTX,
    );
    const store2 = new SkillStore(dbPath);
    const updated = store2.getSkill('my-skill');
    expect(updated?.description).toBe('second');
    expect(updated?.prompt_body).toBe('b2');
    store2.close();
  });

  it('warns about unknown tool names in allowed_tools', async () => {
    const res = await tool.handler(
      { id: 'my-skill', name: 'x', description: 'd', prompt_body: 'b', allowed_tools: ['read_file', 'read-file'], dry_run: true },
      CTX,
    );
    expect(res.content).toMatch(/unknown tool name/i);
    expect(res.content).toContain('read-file');
  });

  it('maps scope=project to the project id', async () => {
    await tool.handler(
      { id: 'proj-skill', name: 'x', description: 'd', prompt_body: 'b', scope: 'project' },
      CTX,
    );
    const store = new SkillStore(dbPath);
    expect(store.getSkill('proj-skill')?.scope).toBe('1');
    store.close();
  });
  it('preserves project scope on update when scope is omitted and cannot overwrite another project', async () => {
    const store = new SkillStore(dbPath);
    try {
      store.upsertSkill({ id: 'owned', name: 'Owned', prompt_body: 'old', scope: '1' });
      store.upsertSkill({ id: 'foreign', name: 'Foreign', prompt_body: 'keep', scope: '2' });
      const updated = await tool.handler({ id: 'owned', name: 'Owned', description: 'd', prompt_body: 'new' }, CTX);
      expect(updated.isError).not.toBe(true); expect(store.getSkill('owned')?.scope).toBe('1');
      const refused = await tool.handler({ id: 'foreign', name: 'Foreign', description: 'd', prompt_body: 'forged' }, CTX);
      expect(refused.isError).toBe(true); expect(store.getSkill('foreign')?.prompt_body).toBe('keep');
    } finally { store.close(); }
  });
  it.each([{ prompt_body: 'x'.repeat(64001) }, { trigger_paths: ['*'.repeat(513)] }, { trigger_roles: Array(17).fill('build') },
    { sort_order: Infinity }, { dry_run: 'yes' }, { scope: 'foreign' }, { context_mode: 'unknown' }, { name: 7 }])(
    'rejects malformed or excessive input before opening the store', async changes => {
      const read = vi.spyOn(SkillStore.prototype, 'getSkill');
      const result = await tool.handler({ id: 'bounded', name: 'Bounded', description: 'd', prompt_body: 'body', ...changes }, CTX);
      expect(result.isError).toBe(true); expect(read).not.toHaveBeenCalled();
    });
  it('does not commit after cancellation during trigger evaluation', async () => {
    const controller = new AbortController();
    const original = SkillStore.prototype.listSkillTriggerCatalog;
    vi.spyOn(SkillStore.prototype, 'listSkillTriggerCatalog').mockImplementationOnce(function (this: SkillStore, ...args) {
      const result = original.apply(this, args); controller.abort(new Error('cancelled')); return result;
    });
    const result = await tool.handler({ id: 'cancelled', name: 'Cancelled', description: 'd', prompt_body: 'body' }, { signal: controller.signal } as ToolContext);
    expect(result.isError).toBe(true); expect(result.content).toContain('cancelled');
    const store = new SkillStore(dbPath); try { expect(store.getSkill('cancelled')).toBeNull(); } finally { store.close(); }
  });
  it('checks authority inside the transaction and keeps a failed commit uncertain', async () => {
    let count = 0;
    const result = await tool.handler({ id: 'revoked', name: 'Revoked', description: 'd', prompt_body: 'body' }, {
      cwd: dir, projectName: 'fixture',
      mutationFence: { mode: 'enforce', bindInvocation() { return this; }, assertMutation() { if (++count === 2) throw new Error('revoked'); } },
    } as ToolContext);
    expect(result.effectOutcome).toBe('unknown');
    const store = new SkillStore(dbPath); try { expect(store.getSkill('revoked')).toBeNull(); } finally { store.close(); }
  });
});
