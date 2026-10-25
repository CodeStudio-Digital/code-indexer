import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { SkillStore } from '../skill-store.js';
const require = createRequire(import.meta.url);

it('searches enabled global/project skills without returning prompt bodies or other scopes', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE skill_definitions (id TEXT, name TEXT, description TEXT, slash_command TEXT, scope TEXT, enabled INTEGER, sort_order INTEGER, prompt_body TEXT)');
  const insert = db.prepare('INSERT INTO skill_definitions VALUES (?, ?, ?, ?, ?, ?, 0, ?)');
  insert.run('review', 'Review', 'Review code', null, 'global', 1, 'hidden prompt');
  insert.run('react', 'React', 'Build React', 'react', '7', 1, 'hidden prompt');
  insert.run('private', 'Review private', 'Review code', 'private', '8', 1, 'hidden prompt');
  insert.run('disabled', 'Disabled', 'Review code', null, 'global', 0, 'hidden prompt');
  try {
    const store = new SkillStore(db);
    expect(store.listComposerSkills(['global', '7'], '').map(row => row.id)).toEqual(['react', 'review']);
    expect(store.listComposerSkills(['global', '7'], 'CODE')).toEqual([{ id: 'review', name: 'Review', description: 'Review code', command: null }]);
    expect(store.listComposerSkills(['global', '7'], '', true).map(row => row.id)).toEqual(['react']);
    expect(store.listComposerSkills(['global', '7'], "' OR 1=1 --")).toEqual([]);
  } finally { db.close(); }
});
