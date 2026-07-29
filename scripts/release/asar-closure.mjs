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

const IMPORT_RE =
  /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Drop lines that are entirely a comment. Prose explaining imports is common in
 * this codebase (`// ... \`import x from 'y'\` dies here`) and the regex above
 * cannot tell it from code — that one comment alone reported a missing package
 * called `y`. Only whole-line comments are removed, never a trailing `//`,
 * so a `'https://…'` inside real code is left intact.
 */
function stripCommentLines(source) {
  return source
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
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
    const source = stripCommentLines(raw);
    let match;
    while ((match = IMPORT_RE.exec(source)) !== null) {
      const spec = match[1] || match[2] || match[3];
      if (!spec) continue;
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
