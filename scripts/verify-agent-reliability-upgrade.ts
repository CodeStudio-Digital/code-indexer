/** Disposable old-source -> current-source -> restart -> rollback proof.
 * Run under Electron --import tsx. Baseline must be an extracted trusted HEAD. */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const workspace = resolve('.');
const baseline = resolve(process.env.RELIABILITY_BASELINE ?? '.tmp/agent-ide-reliability/baseline');
const phase = process.argv[2];
if (!phase) {
  const output = resolve('.tmp/agent-ide-reliability', `upgrade-${Date.now()}`);
  const profile = join(output, 'profile'); mkdirSync(profile, { recursive: true });
  const results: unknown[] = [];
  const run = (step: string, source: string, data = profile) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/verify-agent-reliability-upgrade.ts', step], {
      cwd: workspace, windowsHide: true, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', RELIABILITY_SOURCE: source,
        RELIABILITY_PROFILE: data, TSX_TSCONFIG_PATH: join(source, 'tsconfig.json'),
        MCP_DATA_DIR: data, MCP_INDEX_DB: join(data, 'index.db') },
    });
    writeFileSync(join(output, `${step}.log`), result.stdout + result.stderr);
    assert.equal(result.status, 0, `${step}: ${result.error?.message ?? result.stderr}`);
    const line = result.stdout.split(/\r?\n/).find(l => l.startsWith('UPGRADE_RESULT:'));
    assert.ok(line, `${step}: no completion receipt`);
    results.push(JSON.parse(line.slice('UPGRADE_RESULT:'.length)));
  };
  run('legacy-seed', baseline);
  cpSync(profile, join(output, 'pre-upgrade-backup'), { recursive: true });
  run('upgrade', workspace);
  run('restart', workspace);
  run('legacy-read-upgraded', baseline);
  // Restore to another directory, never overwrite the upgraded profile.
  const restored = join(output, 'restored'); cpSync(join(output, 'pre-upgrade-backup'), restored, { recursive: true });
  run('rollback-backup', baseline, restored);
  writeFileSync(join(output, 'report.json'), JSON.stringify({ at: new Date().toISOString(), baseline,
    scope: 'real source runtimes and SQLite profiles; excludes installer and production user data', results }, null, 2));
  console.log(`PASS upgrade, restart, old-reader compatibility, backup restoration: ${output}`);
} else {
  const profile = process.env.RELIABILITY_PROFILE!;
  const source = process.env.RELIABILITY_SOURCE!;
  const { CodeIndexDB } = await import(pathToFileURL(join(source, 'packages/store/src/db.ts')).href);
  const db = new CodeIndexDB(join(profile, 'index.db'));
  try {
    if (phase === 'legacy-seed') {
      mkdirSync(join(profile, 'project'), { recursive: true });
      const p = db.createProject('upgrade-fixture', join(profile, 'project'));
      db.upsertFile(p.id, { path: 'preserved.ts', language: 'typescript', size: 19, lineCount: 1, contentHash: 'before-upgrade' });
    }
    const project = db.getProjectByName('upgrade-fixture'); assert.ok(project);
    assert.equal(db.getFile(project.id, 'preserved.ts')?.content_hash, 'before-upgrade');
    const raw = db.projectScopedDb(project.id);
    const version = raw.prepare('SELECT max(version) AS version FROM schema_version').get().version;
    if (phase === 'legacy-seed' || phase === 'rollback-backup') assert.equal(version, 270);
    else assert.equal(version, 273);
    if (phase === 'upgrade') {
      const journal = db.structuralJournal();
      journal.put(project.id, [{ path: 'pending.ts', kind: 'upsert', version: 1 }]);
      journal.put(project.id, [{ path: 'pending.ts', kind: 'delete', version: 2 }]);
      journal.ack(project.id, [{ path: 'pending.ts', kind: 'upsert', version: 1 }]);
      assert.deepEqual(journal.load(project.id), [{ path: 'pending.ts', kind: 'delete', version: 2 }]);
      const revision = db.getStructuralRevision(project.id);
      db.upsertFile(project.id, { path: 'after.ts', language: 'typescript', size: 1, lineCount: 1, contentHash: 'after' });
      assert.notEqual(db.getStructuralRevision(project.id), revision);
      writeFileSync(join(profile, 'expected-revision.json'), JSON.stringify(db.getStructuralRevision(project.id)));
    }
    if (phase === 'restart') {
      assert.deepEqual(db.structuralJournal().load(project.id), [{ path: 'pending.ts', kind: 'delete', version: 2 }]);
      assert.equal(db.getStructuralRevision(project.id), JSON.parse(readFileSync(join(profile, 'expected-revision.json'), 'utf8')));
      assert.equal(db.getFile(project.id, 'after.ts')?.content_hash, 'after');
      assert.deepEqual(db.searchFilePaths(project.id, 'preserved', 5), [{ path: 'preserved.ts' }]);
    }
    if (phase === 'legacy-read-upgraded') assert.equal(db.getFile(project.id, 'after.ts')?.content_hash, 'after');
    if (phase === 'rollback-backup') assert.equal(db.getFile(project.id, 'after.ts'), undefined);
    assert.deepEqual(raw.pragma('quick_check'), [{ quick_check: 'ok' }]);
    console.log('UPGRADE_RESULT:' + JSON.stringify({ phase, version, integrity: 'ok', dataPreserved: true }));
  } finally { db.close(); }
}
