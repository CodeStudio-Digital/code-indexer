import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodeIndexDB } from '../db.js';
import { SkillStore } from '../skill-store.js';
let directory: string, db: CodeIndexDB, store: SkillStore;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'skill-authoring-')); db = new CodeIndexDB(join(directory, 'test.db')); store = new SkillStore(db.raw()); });
afterEach(() => { vi.restoreAllMocks(); store.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
it('bounds trigger metadata to admitted scopes and excludes prompt bodies from SQL', () => {
  for (let i = 0; i < 4; i++) store.upsertSkill({ id: `skill-${i}`, name: 'Skill', prompt_body: 'x'.repeat(100_000), scope: i === 3 ? '2' : 'global', trigger_roles: ['build'] });
  const prepare = vi.spyOn(db.raw(), 'prepare');
  const page = store.listSkillTriggerCatalog(1, 2);
  expect(page).toMatchObject({ totalCount: 3, partial: true }); expect(page.items).toHaveLength(2);
  expect(page.items[0]).toMatchObject({ triggerRoles: ['build'] }); expect(page.items[0]).not.toHaveProperty('promptBody');
  expect(prepare.mock.calls.every(([sql]) => !String(sql).includes('prompt_body'))).toBe(true);
});
it('reports partial metadata when legacy arrays exceed the evaluation budget', () => {
  store.upsertSkill({ id: 'oversized', name: 'Large', prompt_body: 'x', trigger_roles: Array.from({ length: 40 }, (_, i) => `role-${i}`) });
  const page = store.listSkillTriggerCatalog(1);
  expect(page.partial).toBe(true); expect(page.items[0].triggerRoles).toHaveLength(32);
});
it('treats quoted scope and wildcard tags as literal filter values', () => {
  store.upsertSkill({ id: 'mine', name: 'Mine', prompt_body: 'x', tags: ['a%b', "tag'quoted"] });
  store.upsertSkill({ id: 'other', name: 'Other', prompt_body: 'x', tags: ['axxb'] });
  expect(store.listSkills({ scope: "global' OR 1=1 --" })).toEqual([]);
  expect(store.listSkills({ tag: 'a%b' }).map(s => s.id)).toEqual(['mine']);
  expect(store.listSkills({ tag: "tag'quoted" }).map(s => s.id)).toEqual(['mine']);
});
it('rechecks ownership under the write lock and rolls back if the final authority check fails', () => {
  store.upsertSkill({ id: 'foreign', name: 'Foreign', prompt_body: 'keep', scope: '2' });
  expect(() => store.upsertAuthoredSkill({ id: 'foreign', name: 'Overwrite', prompt_body: 'x', scope: '1' }, 1, () => {})).toThrow('another project');
  expect(() => store.upsertAuthoredSkill({ id: 'new', name: 'New', prompt_body: 'x' }, 1, () => { throw new Error('revoked'); })).toThrow('revoked');
  expect(store.getSkill('new')).toBeNull(); expect(store.getSkill('foreign')?.prompt_body).toBe('keep');
});
