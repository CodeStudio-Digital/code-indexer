import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { resolveBuildAliases } from '../resolve-build-aliases.mjs';

test('rewrites emitted imports, including imported excluded sources, and never touches frozen packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alias-build-'));
  try {
    await Promise.all(['src', 'imported', 'dist/candidate'].map(dir => mkdir(join(root, dir), { recursive: true })));
    const config = join(root, 'tsconfig.json');
    await writeFile(config, JSON.stringify({ compilerOptions: { outDir: 'dist', rootDir: '.', baseUrl: '.', paths: { '@local/*': ['imported/*'] },
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', declaration: true, skipLibCheck: true }, include: ['src/*.ts'], exclude: ['imported'] }));
    await writeFile(join(root, 'src/index.ts'), "export { value } from '@local/value';");
    await writeFile(join(root, 'imported/value.ts'), "export { value } from '@local/nested';");
    await writeFile(join(root, 'imported/nested.ts'), 'export const value = 42;');
    const frozen = "export { value } from '@local/value'; // frozen";
    await writeFile(join(root, 'dist/candidate/index.js'), frozen);
    const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: assert.fail });
    const program = ts.createProgram(parsed.fileNames, parsed.options); assert.equal(program.emit().emitSkipped, false);
    const result = await resolveBuildAliases(config);
    assert.equal(result.files, 6); assert.equal(result.changed, 4);
    assert.match(await readFile(join(root, 'dist/src/index.js'), 'utf8'), /\.\.\/imported\/value/);
    assert.match(await readFile(join(root, 'dist/imported/value.js'), 'utf8'), /\.\/nested/);
    assert.equal(await readFile(join(root, 'dist/candidate/index.js'), 'utf8'), frozen);
    assert.equal((await resolveBuildAliases(config)).changed, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
