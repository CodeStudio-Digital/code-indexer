// Run with Electron's ELECTRON_RUN_AS_NODE ABI. Only copied fixtures are used;
// this never discovers or opens the installed user's profile.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [archiveArg, snapshotArg, journalsArg, outputArg, baselineReportArg] = process.argv.slice(2);
if (!archiveArg || !snapshotArg || !journalsArg || !outputArg || !baselineReportArg) {
  throw new Error('Usage: <app.asar> <copied-source.index.db> <copied-journals-directory> <new-output-directory> <baseline-journal-report.json>');
}
const archive = resolve(archiveArg), baseline = resolve(snapshotArg), journals = resolve(journalsArg), output = resolve(outputArg);
const expectedJournals = new Map(JSON.parse(await readFile(resolve(baselineReportArg), 'utf8')).sampled.map(item => [item.id, item]));
assert(expectedJournals.size > 0, 'Baseline contains no journal samples');
await mkdir(output, { recursive: true });
const candidate = join(output, 'candidate.index.db');
assert.notEqual(candidate, baseline);
Object.assign(process.env, {
  MCP_DATA_DIR: join(output, 'data'), MCP_RUNTIME_COORDINATION_DIR: join(output, 'coordination'),
  MCP_INDEX_DB: candidate, MCP_DISABLE_TELEMETRY: '1', MCP_PROJECT_DB: '0',
});
const require = createRequire(join(archive, 'package.json'));
const { createReadStream } = require('original-fs');
const Database = require('better-sqlite3');
const tables = [
  'app_settings', 'chrome_service_configs', 'coder_phase_profiles', 'embedding_configs', 'installed_plugins',
  'mcp_connection_profiles', 'mcp_oauth_pending', 'mcp_oauth_registrations', 'mcp_oauth_tokens',
  'mcp_server_configs', 'mcp_server_tools', 'pipeline_provider_bindings', 'plugin_storage',
  'project_editor_config', 'project_lsp_profile_overrides', 'project_runtime_config', 'provider_configs',
  'provider_models', 'reranker_configs', 'semantic_profiles', 'skill_definitions', 'vector_store_configs',
  'db_connections', 'db_query_history', 'db_saved_queries', 'ssh_hosts', 'ssh_identities', 'ssh_port_forwards',
  'ssh_secrets', 'ssh_snippets',
];
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
const report = { schemaVersion: 1, startedAt: new Date().toISOString(),
  scope: 'Packaged migrations on a new copy of an existing snapshot; exact configuration comparison and read-only journal validation; no installed profile or remote drivers',
  candidateAsarSha256: await sha256(archive), sourceSnapshotSha256: await sha256(baseline),
  configurations: [], journals: [], passed: false };
let original, migrated;
try {
  await copyFile(baseline, candidate, constants.COPYFILE_EXCL);
  original = new Database(baseline, { readonly: true, fileMustExist: true });
  original.pragma('query_only = ON');
  migrated = new Database(candidate, { fileMustExist: true });
  migrated.loadExtension(require('sqlite-vec').getLoadablePath().replace(/\.asar([\\/])/, '.asar.unpacked$1'));
  migrated.pragma('foreign_keys = ON');
  const { runMigrations } = await import(pathToFileURL(join(archive, 'dist/packages/store/src/migrations/index.js')).href);
  report.beforeVersion = migrated.prepare('SELECT MAX(version) AS version FROM schema_version').get().version;
  report.migrations = runMigrations(migrated);
  report.afterVersion = migrated.prepare('SELECT MAX(version) AS version FROM schema_version').get().version;
  assert(migrated.pragma('quick_check').every(row => row.quick_check === 'ok'), 'Migrated database failed quick_check');
  for (const table of tables) {
    const select = `SELECT * FROM "${table}"`;
    const before = original.prepare(select).all().map(row => JSON.stringify(row)).sort();
    const after = migrated.prepare(select).all().map(row => JSON.stringify(row)).sort();
    // Compare in memory; no configuration values or credentials are printed.
    const identical = before.length === after.length && before.every((row, index) => row === after[index]);
    report.configurations.push({ table, rows: before.length, identical });
    assert(identical, `Configuration changed: ${table}`);
  }
  original.close(); original = undefined;
  migrated.close(); migrated = undefined;
  const { CodeIndexDB } = await import(pathToFileURL(join(archive, 'dist/packages/store/src/db.js')).href);
  const product = new CodeIndexDB(candidate, { checkpointOwner: false });
  try { report.productDatabaseOpened = true; } finally { product.close(); }
  const { readConversation } = await import(pathToFileURL(join(archive, 'dist/packages/session-storage/src/session-writer.js')).href);
  for (const entry of await readdir(journals, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(journals, entry.name, 'conversation.jsonl');
    const hash = await sha256(path), started = performance.now();
    const records = await readConversation(path);
    const expected = expectedJournals.get(entry.name);
    assert(expected, 'Journal sample has no baseline');
    assert.equal((await stat(path)).size, expected.bytes, 'Journal sample size differs from baseline');
    assert.equal(records.length, expected.commits, 'Journal commit count differs from baseline');
    assert.equal(await sha256(path), hash, 'Read modified a journal');
    report.journals.push({ sample: entry.name, commits: records.length, validationMs: performance.now() - started });
  }
  assert.equal(report.journals.length, expectedJournals.size, 'Missing journal samples');
  assert.equal(await sha256(baseline), report.sourceSnapshotSha256, 'Baseline snapshot changed');
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  original?.close(); migrated?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, beforeVersion: report.beforeVersion, afterVersion: report.afterVersion,
    tables: report.configurations.length, journals: report.journals.length, failure: report.failure, output }));
}
