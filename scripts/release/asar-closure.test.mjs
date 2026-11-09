import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compiledRuntimeWorker, moduleSpecifiers } from './asar-closure.mjs';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('follows module imports and worker dependencies without treating prose or methods as imports', () => {
  const source = `
    import { a } from './first.js';
    export * from './second.js';
    import('./third.js');
    const a = require('plain');
    require.resolve('worker-dependency');
    module.require('node:fs');
    state.require('active');
    const sample = "require('example-only')";
    // require('comment')
    /* import 'another-comment'; */
  `;
  assert.deepEqual(moduleSpecifiers(source), ['./first.js', './second.js', './third.js', 'plain', 'worker-dependency', 'node:fs']);
});

test('omits only the development tsx lookup when the compiled startup worker is packaged', () => {
  const importer = 'dist/apps/http-api/server/database-startup.js';
  const worker = 'dist/apps/http-api/workers/database-startup-worker.js';
  const source = ts.transpileModule(readFileSync(new URL('../../apps/http-api/server/database-startup.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const files = new Set([worker]);
  assert.equal(compiledRuntimeWorker(importer, source, files), worker);
  assert.equal(compiledRuntimeWorker(importer, source, new Set()), null);
  assert.equal(compiledRuntimeWorker('another.js', source, files), null);
  assert.equal(compiledRuntimeWorker(importer, source.replace('existsSync(built)', 'existsSync(source)'), files), null);
  assert.equal(compiledRuntimeWorker(importer, source.replace('const compiled =', 'let compiled ='), files), null);
  assert.equal(compiledRuntimeWorker(importer, source.replace('compiled ? [] :', '!compiled ? [] :'), files), null);
  assert.equal(compiledRuntimeWorker(importer, source + "\nrequire.resolve('tsx');", files), null);
  assert.equal(compiledRuntimeWorker(importer, source + "\nimport 'tsx';", files), null);
  assert.equal(compiledRuntimeWorker(importer, source + "\nrequire('tsx');", files), null);
  assert.equal(compiledRuntimeWorker(importer, source + "\nfunction another(compiled) { return compiled ? [] : require.resolve('tsx'); }", files), null);
});

test('checks the packaged SQLite child while omitting its source-only loader', () => {
  const importer = 'dist/packages/db-drivers/src/sqlite-process.js';
  const worker = 'dist/packages/db-drivers/src/sqlite-process-entry.js';
  const source = ts.transpileModule(readFileSync(new URL('../../packages/db-drivers/src/sqlite-process.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const files = new Set([worker]);
  assert.equal(compiledRuntimeWorker(importer, source, files), worker);
  assert.equal(compiledRuntimeWorker(importer, source, new Set()), null);
  assert.equal(compiledRuntimeWorker(importer, source.replace("endsWith('.ts')", "endsWith('.js')"), files), null);
  assert.equal(compiledRuntimeWorker(importer, source.replace('const source =', 'let source ='), files), null);
  assert.equal(compiledRuntimeWorker(importer, source.replace("source ? ['--import'", "!source ? ['--import'"), files), null);
  assert.equal(compiledRuntimeWorker(importer, source.replace("'./sqlite-process-entry.js'", "'./missing.js'"), files), null);
  assert.equal(compiledRuntimeWorker(importer, source + "\nrequire.resolve('tsx');", files), null);
  assert.equal(compiledRuntimeWorker(importer, source + "\nfunction another(source) { return source ? require.resolve('tsx') : []; }", files), null);
});
