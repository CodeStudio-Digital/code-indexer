// Rewrite only outputs of this TypeScript program. Scanning all of dist also
// visits previous Electron candidates and vendored editor bundles, multiplying
// every build's work and putting frozen artifacts in the rewrite scope.
import ts from 'typescript';
import { prepareSingleFileReplaceTscAliasPaths } from 'tsc-alias';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

export async function resolveBuildAliases(configPath) {
  const started = performance.now(), configFile = resolve(configPath);
  const parsed = ts.getParsedCommandLineOfConfigFile(configFile, {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic(error) { throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n')); },
  });
  if (!parsed || parsed.errors.length || !parsed.options.outDir || parsed.options.outFile) throw new Error('Alias rewrite requires a valid project with outDir and individual outputs');
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true }, projectReferences: parsed.projectReferences });
  const files = program.getSourceFiles().filter(file => !file.isDeclarationFile && !program.isSourceFileFromExternalLibrary(file)).map(file => file.fileName);
  const emitConfig = { ...parsed, fileNames: files };
  const outputs = new Set(files.flatMap(file => ts.getOutputFileNames(emitConfig, file, !ts.sys.useCaseSensitiveFileNames)).filter(file => /\.(?:[cm]?js|jsx|d\.[cm]?ts)$/.test(file)));
  const roots = [parsed.options.outDir, parsed.options.declarationDir].filter(Boolean).map(root => resolve(root));
  const replace = await prepareSingleFileReplaceTscAliasPaths({ configFile });
  let changed = 0;
  // Bounded IO concurrency; no recursive traversal of dist or packaged apps.
  const pending = [...outputs]; let cursor = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (cursor < pending.length) {
      const filePath = pending[cursor++];
      if (!roots.some(root => { const rel = relative(root, filePath); return rel && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel); })) throw new Error('TypeScript output escapes its configured directory');
      const fileContents = await readFile(filePath, 'utf8');
      const next = replace({ filePath, fileContents });
      if (next !== fileContents) { await writeFile(filePath, next); changed++; }
    }
  }));
  return { config: relative(dirname(configFile), configFile), files: outputs.size, changed, elapsedMs: performance.now() - started };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await resolveBuildAliases(process.argv[2] ?? 'tsconfig.json')));
}
