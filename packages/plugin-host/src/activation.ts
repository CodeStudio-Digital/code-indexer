/**
 * Project-context activation for plugin contributions. A tool window may carry
 * an `activation` rule (whenFiles / whenPackageDep); the HOST evaluates it
 * against a project's root so the IDE only surfaces the window when the project
 * actually matches (e.g. a Cloudflare panel appears only in a wrangler project).
 * No plugin code runs — this is a declarative, filesystem-only check.
 */
import { existsSync, promises as fs, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface ActivationRule {
  whenFiles?: string[];
  whenPackageDep?: string[];
}

/** Does the project root contain a file matching `pat` (exact name or `*.ext`)? */
function fileMatches(root: string, pat: string): boolean {
  if (pat.startsWith('*.')) {
    const ext = pat.slice(1); // ".ext"
    try {
      return readdirSync(root).some((f) => f.endsWith(ext));
    } catch {
      return false;
    }
  }
  return existsSync(join(root, pat));
}

/** Read package.json's combined deps once (empty set on any failure). */
function packageDeps(root: string): Set<string> {
  try {
    return parseDeps(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return new Set();
  }
}

function parseDeps(text: string): Set<string> {
  const pkg = JSON.parse(text);
  return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
}

/** One checkout evaluation shares its reads, including misses, across plugins.
 * A later request sees newly created files and manifest edits immediately. */
export function createAsyncActivationCheck(root: string | null) {
  const files = new Map<string, Promise<boolean>>();
  let listing: Promise<string[]> | undefined;
  let deps: Promise<Set<string>> | undefined;
  return async (rule: ActivationRule | undefined): Promise<boolean> => {
    if (!rule?.whenFiles?.length && !rule?.whenPackageDep?.length) return true;
    if (!root) return false;
    for (const pattern of rule.whenFiles ?? []) {
      let matches = files.get(pattern);
      if (!matches) {
        if (pattern.startsWith('*.')) {
          listing ??= fs.readdir(root).catch(() => []);
          matches = listing.then(names => names.some(name => name.endsWith(pattern.slice(1))));
        } else {
          matches = fs.access(join(root, pattern)).then(() => true, () => false);
        }
        files.set(pattern, matches);
      }
      if (await matches) return true;
    }
    if (!rule.whenPackageDep?.length) return false;
    deps ??= fs.readFile(join(root, 'package.json'), 'utf8').then(parseDeps).catch(() => new Set<string>());
    const installed = await deps;
    return rule.whenPackageDep.some(name => installed.has(name));
  };
}

/**
 * Evaluate one activation rule against a project root. No rule → always active.
 * OR semantics: any satisfied condition activates. `root` null (no project) →
 * only undefined-rule contributions are active.
 */
export function isActivated(rule: ActivationRule | undefined, root: string | null): boolean {
  if (!rule || (!rule.whenFiles?.length && !rule.whenPackageDep?.length)) return true;
  if (!root) return false;
  if (rule.whenFiles?.some((f) => fileMatches(root, f))) return true;
  if (rule.whenPackageDep?.length) {
    const deps = packageDeps(root);
    if (rule.whenPackageDep.some((d) => deps.has(d))) return true;
  }
  return false;
}
