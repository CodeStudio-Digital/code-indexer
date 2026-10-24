import assert from 'node:assert/strict';

/** Only runs inside the harness's isolated profile, before sending a chat. */
export async function seedExistingProjectFixture(app, projectId) {
  const evidence = await app.evaluate(({ app }, projectId) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
    const db = new CodeIndexDB(process.env.MCP_INDEX_DB);
    try {
      db.setProjectSplitStatus(projectId, 'done');
      if (!db.useProjectDb(projectId)) throw new Error('Existing project fixture requires active project DB routing');
      db.projectScopedDb(projectId); // seed its owned project row before downgrade
      const project = db.forProject(projectId), raw = project.raw();
      const semanticTable = raw.prepare("SELECT name FROM sqlite_master WHERE name='semantic_jobs'").get();
      if (semanticTable) throw new Error('Expected a trimmed project database');
      raw.prepare('UPDATE projects SET description=? WHERE id=?').run('HARNESS_EXISTING_PROJECT_PRESERVED', projectId);
      raw.prepare('DELETE FROM schema_version WHERE version >= ?').run(268);
      return { projectId, dbPath: project.dbPath, previousVersion: raw.prepare('SELECT MAX(version) AS v FROM schema_version').get().v,
        semanticTableAbsent: true, splitStatus: db.getProjectSplitStatus(projectId) };
    } finally { db.close(); }
  }, projectId);
  assert.equal(evidence.previousVersion, 267); return evidence;
}

export async function verifyExistingProjectFixture(app, evidence) {
  const result = await app.evaluate(({ app }, evidence) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { openRawProjectDb } = require(join(app.getAppPath(), 'dist/packages/store/src/project-db/open.js'));
    const raw = openRawProjectDb(evidence.dbPath, { readonly: true });
    try {
      return { migrationAppliedByChat: !!raw.prepare('SELECT 1 FROM schema_version WHERE version=268').get(),
        semanticTableStillAbsent: !raw.prepare("SELECT 1 FROM sqlite_master WHERE name='semantic_jobs'").get(),
        existingDataPreserved: raw.prepare('SELECT description FROM projects WHERE id=?').get(evidence.projectId)?.description === 'HARNESS_EXISTING_PROJECT_PRESERVED',
        integrity: raw.pragma('quick_check', { simple: true }) };
    } finally { raw.close(); }
  }, evidence);
  assert.equal(result.migrationAppliedByChat, true, 'chat did not reopen the old project database');
  assert.equal(result.semanticTableStillAbsent, true); assert.equal(result.integrity, 'ok');
  assert.equal(result.existingDataPreserved, true, 'existing project data was replaced');
  return { ...evidence, ...result, passed: true };
}
