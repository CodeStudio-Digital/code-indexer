/**
 * Static proof that the packaged app can resolve every module it loads.
 *
 * ERR_MODULE_NOT_FOUND at launch has been this project's most expensive class
 * of packaging bug, and it has two distinct causes:
 *   - first-party: a `dist/apps/<x>` directory missing from electron-builder's
 *     `files` whitelist;
 *   - third-party: a dependency declared only in a workspace package, which
 *     electron-builder (which reads the ROOT manifest) never bundles.
 *
 * Both are caught here by walking the module graph from the real entry points
 * against the ACTUAL asar contents — no launching required.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

const require = createRequire(import.meta.url);

/** `@electron/asar` is a transitive dep of electron-builder, not hoisted under pnpm. */
function loadAsar(root) {
  const fromRoot = createRequire(path.join(root, 'package.json'));
  const builder = fromRoot.resolve('electron-builder');
  const fromBuilder = createRequire(builder);
  let target;
  try {
    target = fromBuilder.resolve('@electron/asar');
  } catch {
    const lib = fromBuilder.resolve('app-builder-lib');
    target = createRequire(lib).resolve('@electron/asar');
  }
  return createRequire(target)(target);
}

/**
 * Import-like text that is CONTENT, not code this app runs: scaffold generators
 * emit source files into the user's generated projects, and tree-sitter query
 * strings look like imports to a regex. Skipping them keeps the report honest.
 */
const TEMPLATE_SOURCES =
  /host-scaffold\/|source-stamp\/|scaffolders\/|reporter-template|skills\/builtin\/|tree-sitter\/extractor\.js/;

/** Parse code so method calls, comments and source examples are not mistaken
 * for modules. require.resolve includes dependencies passed to isolated workers. */
export function moduleSpecifiers(source) {
  const tree = ts.createSourceFile('module.js', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const found = new Set();
  const add = node => { if (node && ts.isStringLiteralLike(node)) found.add(node.text); };
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isCallExpression(node)) {
      const fn = node.expression;
      if (fn.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(fn) && fn.text === 'require') ||
        (ts.isPropertyAccessExpression(fn) && ts.isIdentifier(fn.expression) &&
          ((fn.expression.text === 'require' && fn.name.text === 'resolve') ||
           (fn.expression.text === 'module' && fn.name.text === 'require')))) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree); return [...found];
}

const STARTUP_IMPORTER = 'dist/apps/http-api/server/database-startup.js';
const STARTUP_WORKER = 'dist/apps/http-api/workers/database-startup-worker.js';
const SQLITE_IMPORTER = 'dist/packages/db-drivers/src/sqlite-process.js';
const SQLITE_WORKER = 'dist/packages/db-drivers/src/sqlite-process-entry.js';

/** A packaged startup always selects its compiled worker. Only omit the dev
 * loader when its actual AST branch and the archived worker prove that fact. */
export function compiledRuntimeWorker(importer, source, archiveFiles) {
  const sqlite = importer === SQLITE_IMPORTER;
  const worker = sqlite ? SQLITE_WORKER : STARTUP_WORKER;
  const pathName = sqlite ? 'entry' : 'built', conditionName = sqlite ? 'source' : 'compiled';
  if ((!sqlite && importer !== STARTUP_IMPORTER) || !archiveFiles.has(worker)) return null;
  const tree = ts.createSourceFile('startup.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = [], lookups = [];
  let importsExistsSync = false, unconditionalTsx = false;
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'tsx') unconditionalTsx = true;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'node:fs') {
      const bindings = node.importClause?.namedBindings;
      importsExistsSync ||= !!bindings && ts.isNamedImports(bindings)
        && bindings.elements.some(item => item.name.text === 'existsSync' && !item.propertyName);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && [pathName, conditionName].includes(node.name.text)) declarations.push(node);
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'tsx') {
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.getText(tree) === 'require.resolve') lookups.push(node);
      else if (['require', 'module.require', 'import'].includes(node.expression.getText(tree))) unconditionalTsx = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const built = declarations.filter(node => node.name.text === pathName);
  const compiled = declarations.filter(node => node.name.text === conditionName);
  if (unconditionalTsx || (!sqlite && !importsExistsSync) || built.length !== 1 || compiled.length !== 1 || lookups.length === 0) return null;
  if (![built[0], compiled[0]].every(node => node.parent.flags & ts.NodeFlags.Const)) return null;
  let url = built[0].initializer;
  const check = compiled[0].initializer;
  if (sqlite) {
    if (!url || !ts.isCallExpression(url) || url.expression.getText(tree) !== 'fileURLToPath' || url.arguments.length !== 1) return null;
    url = url.arguments[0];
    if (!check || !ts.isCallExpression(check) || check.expression.getText(tree) !== 'import.meta.url.endsWith'
      || check.arguments.length !== 1 || !ts.isStringLiteral(check.arguments[0]) || check.arguments[0].text !== '.ts') return null;
  }
  if (!url || !ts.isNewExpression(url) || url.expression.getText(tree) !== 'URL'
    || !url.arguments?.[0]
    || url.arguments[1]?.getText(tree) !== 'import.meta.url') return null;
  const workerPath = url.arguments[0];
  if (sqlite) {
    if (!ts.isConditionalExpression(workerPath) || workerPath.condition.getText(tree) !== 'source'
      || !ts.isStringLiteral(workerPath.whenFalse) || workerPath.whenFalse.text !== './sqlite-process-entry.js') return null;
  } else {
    if (!ts.isStringLiteral(workerPath) || workerPath.text !== '../workers/database-startup-worker.js') return null;
    if (!check || !ts.isCallExpression(check) || check.expression.getText(tree) !== 'existsSync'
      || check.arguments.length !== 1 || check.arguments[0].getText(tree) !== 'built') return null;
  }
  for (const lookup of lookups) {
    const enclosingFunction = node => { while (node && !ts.isFunctionLike(node)) node = node.parent; return node; };
    if (enclosingFunction(lookup) !== enclosingFunction(built[0]) || enclosingFunction(lookup) !== enclosingFunction(compiled[0])) return null;
    let branch = lookup;
    while (branch.parent && !ts.isConditionalExpression(branch.parent)) branch = branch.parent;
    const conditional = branch.parent;
    if (!conditional || !ts.isConditionalExpression(conditional)
      || conditional.condition.getText(tree) !== conditionName || (sqlite ? conditional.whenTrue : conditional.whenFalse) !== branch) return null;
  }
  return worker;
}

export function checkAsarClosure(root, asarPath, entries) {
  const asar = loadAsar(root);
  const listed = asar
    .listPackage(asarPath)
    .map((f) => f.split(path.sep).join('/').replace(/^\//, ''));
  const files = new Set(listed);

  // Top-level package directories present under node_modules/ in the archive.
  const packages = new Set(
    listed
      .filter((f) => f.startsWith('node_modules/'))
      .map((f) => {
        const parts = f.split('/');
        return parts[1]?.startsWith('@') ? `${parts[1]}/${parts[2]}` : parts[1];
      }),
  );

  const read = (rel) => {
    for (const form of [rel, rel.split('/').join('\\'), `/${rel}`]) {
      try {
        return asar.extractFile(asarPath, form).toString('utf8');
      } catch {
        /* path separator form differs across archives — try the next */
      }
    }
    return null;
  };

  const resolveRelative = (from, spec) => {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    for (const candidate of [
      target,
      `${target}.js`,
      `${target}.cjs`,
      `${target}.mjs`,
      path.posix.join(target, 'index.js'),
    ]) {
      if (files.has(candidate)) return candidate;
    }
    return null;
  };

  const builtins = new Set(require('node:module').builtinModules);
  const visited = new Set();
  const bare = new Map();
  const missingFirstParty = [];
  const queue = entries.filter((e) => files.has(e));
  const unknownEntries = entries.filter((e) => !files.has(e));

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    const raw = read(current);
    if (raw == null) continue;
    const compiledWorker = compiledRuntimeWorker(current, raw, files);
    if (compiledWorker && !visited.has(compiledWorker)) queue.push(compiledWorker);
    for (const spec of moduleSpecifiers(raw)) {
      if (!spec) continue;
      if (spec === 'tsx' && compiledWorker) continue;
      if (spec.startsWith('.')) {
        const resolved = resolveRelative(current, spec);
        if (resolved == null) {
          if (!TEMPLATE_SOURCES.test(current)) missingFirstParty.push({ from: current, spec });
        } else if (!visited.has(resolved)) {
          queue.push(resolved);
        }
        continue;
      }
      if (spec.startsWith('node:') || TEMPLATE_SOURCES.test(current)) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!bare.has(name)) bare.set(name, current);
    }
  }

  const missingPackages = [];
  for (const [name, importer] of bare) {
    if (builtins.has(name) || name === 'electron') continue;
    // A bare specifier can also be a template-literal artefact (`${pkg}`) or a
    // word picked out of a comment; those never look like real package names.
    if (name.includes('${') || !/^[@a-z0-9]/i.test(name)) continue;
    if (!packages.has(name)) missingPackages.push({ name, importer });
  }

  return {
    ok: missingFirstParty.length === 0 && missingPackages.length === 0 && unknownEntries.length === 0,
    scanned: visited.size,
    archiveFiles: files.size,
    barePackages: bare.size,
    unknownEntries,
    missingFirstParty,
    missingPackages,
  };
}
