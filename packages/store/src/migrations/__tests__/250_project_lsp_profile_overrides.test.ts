import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { projectLspProfileOverrides250 } from '../250_project_lsp_profile_overrides.js';
import {
  listProjectLspProfileOverrides,
  removeProjectLspProfileOverride,
  setProjectLspProfileOverride,
} from '../../lsp-profile-overrides.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY)');
  projectLspProfileOverrides250.up(db);
  db.prepare('INSERT INTO projects(id) VALUES (?)').run(7);
});
afterEach(() => db.close());

describe('migration 250 - project LSP profile overrides', () => {
  it('upserts, lists and removes one workspace override', () => {
    const input = {
      projectId: 7,
      familyId: 'angular-language-server',
      workspacePath: 'apps/legacy',
      profileId: 'angular-12',
    };
    setProjectLspProfileOverride(db, input);
    setProjectLspProfileOverride(db, { ...input, profileId: 'angular-13' });

    expect(listProjectLspProfileOverrides(db, 7, input.familyId)).toEqual([
      expect.objectContaining({ ...input, profileId: 'angular-13' }),
    ]);
    removeProjectLspProfileOverride(db, 7, input.familyId, input.workspacePath);
    expect(listProjectLspProfileOverrides(db, 7, input.familyId)).toEqual([]);
  });

  it('cascades overrides with the project row', () => {
    setProjectLspProfileOverride(db, {
      projectId: 7,
      familyId: 'angular-language-server',
      workspacePath: '.',
      profileId: 'angular-9',
    });
    db.prepare('DELETE FROM projects WHERE id = ?').run(7);
    expect(listProjectLspProfileOverrides(db, 7, 'angular-language-server')).toEqual([]);
  });
});
