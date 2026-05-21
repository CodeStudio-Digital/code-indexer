/**
 * AutoDiscoveryService — scans a project's dependency manifests and
 * SUGGESTS doc collections by resolving each detected package to its
 * canonical documentation URL.
 *
 * Detectors:
 *   - package.json   → npm registry API
 *   - requirements.txt + pyproject.toml → pypi
 *   - Cargo.toml     → crates.io
 *   - go.mod         → pkg.go.dev (URL synthesis — no detail API needed)
 *   - composer.json  → packagist
 *   - Gemfile        → rubygems
 *
 * Resolution policy: prefer `documentation` > `homepage` > `repository`
 * (in the registry response). Confidence is set conservatively (0.7 for
 * a documentation field, 0.5 for homepage, 0.4 for a synthesized URL).
 *
 * Anti-duplication: `(project_id, package_manager, package_name)` is
 * UNIQUE in `doc_source_suggestions`; we use `INSERT OR IGNORE` so a
 * re-scan doesn't reset a user's earlier `dismissed`/`approved` verdict.
 *
 * Throttling: per-host token-bucket at 2 req/s. Misses (404, network
 * error) cache as `null` for 7 days so a re-scan doesn't pound the
 * registry on packages it can't resolve.
 *
 * Network: uses the process-global `fetch`. Tests stub `fetch` with
 * `vi.stubGlobal` — the throttle is module-scoped so it should be
 * cleared between runs (call `_resetAutoDiscoveryThrottle` from tests).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export type PackageManager = 'npm' | 'pypi' | 'cargo' | 'go' | 'composer' | 'rubygems';

export interface DepManifest {
  package_manager: PackageManager;
  package_name: string;
  package_version: string | null;
}

export interface DepSuggestion extends DepManifest {
  suggested_url: string;
  suggested_title: string | null;
  confidence: number;
}

export interface AutoDiscoveryServiceOpts {
  /** SQLite handle backing `doc_source_suggestions`. */
  db: DB;
  /**
   * Optional fetch override — used by tests to bypass the global. The
   * default uses `globalThis.fetch` so production picks up Node 18+'s
   * undici-backed fetch automatically.
   */
  fetchImpl?: typeof fetch;
  /** Logger for status / failure messages. Defaults to console.warn. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface ScanInput {
  projectId: number;
  /** Absolute path to the project root. */
  projectRoot: string;
}

export interface ScanResult {
  manifestsFound: PackageManager[];
  packagesDetected: number;
  suggestionsInserted: number;
  suggestionsSkipped: number;
}

interface ResolveCacheEntry {
  url: string | null;
  title: string | null;
  resolvedAt: number;
}

const HOST_THROTTLE_MS = 500; // 2 req/s
const RESOLVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const hostLastCallAt = new Map<string, number>();
const resolveCache = new Map<string, ResolveCacheEntry>();

/** Test helper — clears module-scope throttle + cache. */
export function _resetAutoDiscoveryThrottle(): void {
  hostLastCallAt.clear();
  resolveCache.clear();
}

export class AutoDiscoveryService {
  private readonly fetchImpl: typeof fetch;
  private readonly log: NonNullable<AutoDiscoveryServiceOpts['log']>;

  constructor(private readonly opts: AutoDiscoveryServiceOpts) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.log = opts.log ?? ((_level, msg) => console.warn(`[auto-discovery] ${msg}`));
  }

  /**
   * Walk the project root, detect manifests, resolve packages, and
   * persist suggestions. Skips packages already in `doc_sources` (by URL)
   * so the same URL doesn't appear twice in the dashboard.
   */
  async scan(input: ScanInput): Promise<ScanResult> {
    const detectors: Array<{ name: PackageManager; run: () => Promise<DepManifest[]> }> = [
      { name: 'npm',      run: () => this.detectNpm(input.projectRoot) },
      { name: 'pypi',     run: () => this.detectPypi(input.projectRoot) },
      { name: 'cargo',    run: () => this.detectCargo(input.projectRoot) },
      { name: 'go',       run: () => this.detectGo(input.projectRoot) },
      { name: 'composer', run: () => this.detectComposer(input.projectRoot) },
      { name: 'rubygems', run: () => this.detectRubygems(input.projectRoot) },
    ];

    const manifestsFound: PackageManager[] = [];
    const allManifests: DepManifest[] = [];
    for (const detector of detectors) {
      try {
        const found = await detector.run();
        if (found.length > 0) {
          manifestsFound.push(detector.name);
          allManifests.push(...found);
        }
      } catch (err) {
        this.log('warn', `${detector.name} detector failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const existingDocUrls = this.listExistingDocSourceUrls();

    let suggestionsInserted = 0;
    let suggestionsSkipped = 0;
    for (const manifest of allManifests) {
      const resolved = await this.resolveDocUrl(manifest);
      if (!resolved || existingDocUrls.has(resolved.suggested_url)) {
        suggestionsSkipped++;
        continue;
      }
      const inserted = this.persistSuggestion(input.projectId, resolved);
      if (inserted) suggestionsInserted++;
      else suggestionsSkipped++;
    }

    return {
      manifestsFound,
      packagesDetected: allManifests.length,
      suggestionsInserted,
      suggestionsSkipped,
    };
  }

  // ─── Detectors ───────────────────────────────────────────────────

  private async detectNpm(root: string): Promise<DepManifest[]> {
    const file = path.join(root, 'package.json');
    const text = await readIfExists(file);
    if (!text) return [];
    try {
      const json = JSON.parse(text) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = {
        ...(json.dependencies ?? {}),
        ...(json.devDependencies ?? {}),
      };
      return Object.entries(deps).map(([name, version]) => ({
        package_manager: 'npm' as const,
        package_name: name,
        package_version: stripVersionPrefix(version),
      }));
    } catch {
      return [];
    }
  }

  private async detectPypi(root: string): Promise<DepManifest[]> {
    const found: DepManifest[] = [];
    // requirements.txt — one `pkg==1.2.3` per line.
    const reqText = await readIfExists(path.join(root, 'requirements.txt'));
    if (reqText) {
      for (const line of reqText.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = /^([A-Za-z0-9_.-]+)(?:[<>=!~]+(.+))?/.exec(trimmed);
        if (match) {
          found.push({
            package_manager: 'pypi',
            package_name: match[1]!,
            package_version: match[2]?.trim() ?? null,
          });
        }
      }
    }
    // pyproject.toml — dependencies under [project] or [tool.poetry.dependencies].
    const tomlText = await readIfExists(path.join(root, 'pyproject.toml'));
    if (tomlText) {
      // Lightweight regex parser — avoids pulling in a full TOML lib for
      // detect-only logic. Looks for "name = version" lines inside the
      // [project] dependencies array OR [tool.poetry.dependencies] table.
      for (const match of tomlText.matchAll(
        /^\s*"?([A-Za-z0-9_.-]+)"?\s*=\s*"([^"]+)"/gm,
      )) {
        const name = match[1]!;
        const ver = match[2]!;
        // Skip Python itself + metadata keys.
        if (/^(python|name|version|description|readme|authors)$/i.test(name)) continue;
        // Avoid duplicates from requirements.txt above.
        if (found.some((f) => f.package_name === name)) continue;
        found.push({
          package_manager: 'pypi',
          package_name: name,
          package_version: stripVersionPrefix(ver),
        });
      }
    }
    return found;
  }

  private async detectCargo(root: string): Promise<DepManifest[]> {
    const text = await readIfExists(path.join(root, 'Cargo.toml'));
    if (!text) return [];
    const found: DepManifest[] = [];
    // Only look inside [dependencies] / [dev-dependencies] sections.
    const sections = text.split(/^\[/m);
    for (const section of sections) {
      if (!/^(dev-)?dependencies\]/.test(section)) continue;
      for (const match of section.matchAll(
        /^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/gm,
      )) {
        found.push({
          package_manager: 'cargo',
          package_name: match[1]!,
          package_version: stripVersionPrefix(match[2]!),
        });
      }
    }
    return found;
  }

  private async detectGo(root: string): Promise<DepManifest[]> {
    const text = await readIfExists(path.join(root, 'go.mod'));
    if (!text) return [];
    const found: DepManifest[] = [];
    // `require <module> <version>` (or `require ( ... )` block).
    const lines = text.split(/\r?\n/);
    let inBlock = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === 'require (') {
        inBlock = true;
        continue;
      }
      if (inBlock && trimmed === ')') {
        inBlock = false;
        continue;
      }
      const match = inBlock
        ? /^([\w./-]+)\s+(\S+)/.exec(trimmed)
        : /^require\s+([\w./-]+)\s+(\S+)/.exec(trimmed);
      if (match) {
        found.push({
          package_manager: 'go',
          package_name: match[1]!,
          package_version: match[2] ?? null,
        });
      }
    }
    return found;
  }

  private async detectComposer(root: string): Promise<DepManifest[]> {
    const text = await readIfExists(path.join(root, 'composer.json'));
    if (!text) return [];
    try {
      const json = JSON.parse(text) as {
        require?: Record<string, string>;
        'require-dev'?: Record<string, string>;
      };
      const all = { ...(json.require ?? {}), ...(json['require-dev'] ?? {}) };
      return Object.entries(all)
        .filter(([name]) => name !== 'php' && !name.startsWith('ext-'))
        .map(([name, version]) => ({
          package_manager: 'composer' as const,
          package_name: name,
          package_version: stripVersionPrefix(version),
        }));
    } catch {
      return [];
    }
  }

  private async detectRubygems(root: string): Promise<DepManifest[]> {
    const text = await readIfExists(path.join(root, 'Gemfile'));
    if (!text) return [];
    const found: DepManifest[] = [];
    // `gem "name"` or `gem "name", "1.2.3"` or `gem 'name', '~> 1.2'`.
    for (const match of text.matchAll(
      /^\s*gem\s+['"]([\w.-]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/gm,
    )) {
      found.push({
        package_manager: 'rubygems',
        package_name: match[1]!,
        package_version: match[2] ? stripVersionPrefix(match[2]) : null,
      });
    }
    return found;
  }

  // ─── Registry resolvers ──────────────────────────────────────────

  private async resolveDocUrl(m: DepManifest): Promise<DepSuggestion | null> {
    const cacheKey = `${m.package_manager}:${m.package_name}`;
    const cached = resolveCache.get(cacheKey);
    if (cached && Date.now() - cached.resolvedAt < RESOLVE_CACHE_TTL_MS) {
      if (!cached.url) return null;
      return {
        ...m,
        suggested_url: cached.url,
        suggested_title: cached.title,
        confidence: 0.5,
      };
    }

    let resolved: { url: string | null; title: string | null; confidence: number };
    try {
      resolved = await this.fetchResolution(m);
    } catch (err) {
      this.log('warn', `resolve ${cacheKey} failed: ${err instanceof Error ? err.message : String(err)}`);
      resolveCache.set(cacheKey, { url: null, title: null, resolvedAt: Date.now() });
      return null;
    }
    resolveCache.set(cacheKey, { url: resolved.url, title: resolved.title, resolvedAt: Date.now() });
    if (!resolved.url) return null;
    return {
      ...m,
      suggested_url: resolved.url,
      suggested_title: resolved.title,
      confidence: resolved.confidence,
    };
  }

  private async fetchResolution(
    m: DepManifest,
  ): Promise<{ url: string | null; title: string | null; confidence: number }> {
    switch (m.package_manager) {
      case 'npm':
        return this.fetchNpmRegistry(m.package_name);
      case 'pypi':
        return this.fetchPypiRegistry(m.package_name);
      case 'cargo':
        return this.fetchCratesIo(m.package_name);
      case 'go':
        // pkg.go.dev doesn't need a JSON lookup — the URL is canonical.
        return {
          url: `https://pkg.go.dev/${m.package_name}`,
          title: m.package_name,
          confidence: 0.4,
        };
      case 'composer':
        return this.fetchPackagist(m.package_name);
      case 'rubygems':
        return this.fetchRubygems(m.package_name);
    }
  }

  private async fetchNpmRegistry(name: string): Promise<{ url: string | null; title: string | null; confidence: number }> {
    const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
    const json = await this.fetchJson(url);
    if (!json) return { url: null, title: null, confidence: 0 };
    const homepage = typeof json.homepage === 'string' ? json.homepage : null;
    const repoUrl = (json.repository as { url?: string } | undefined)?.url ?? null;
    const description = typeof json.description === 'string' ? json.description.slice(0, 200) : null;
    if (homepage) return { url: homepage, title: description ?? name, confidence: 0.5 };
    if (repoUrl) return { url: normalizeGitUrl(repoUrl), title: description ?? name, confidence: 0.45 };
    return { url: `https://www.npmjs.com/package/${name}`, title: description ?? name, confidence: 0.3 };
  }

  private async fetchPypiRegistry(name: string): Promise<{ url: string | null; title: string | null; confidence: number }> {
    const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
    const json = await this.fetchJson(url);
    if (!json) return { url: null, title: null, confidence: 0 };
    const info = (json.info ?? {}) as { project_urls?: Record<string, string>; home_page?: string; summary?: string };
    const projectUrls = info.project_urls ?? {};
    const docs = projectUrls.Documentation ?? projectUrls['Documentation'] ?? null;
    const homepage = info.home_page ?? projectUrls.Homepage ?? null;
    const title = info.summary?.slice(0, 200) ?? name;
    if (docs) return { url: docs, title, confidence: 0.7 };
    if (homepage) return { url: homepage, title, confidence: 0.5 };
    return { url: `https://pypi.org/project/${name}/`, title, confidence: 0.3 };
  }

  private async fetchCratesIo(name: string): Promise<{ url: string | null; title: string | null; confidence: number }> {
    const url = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`;
    const json = await this.fetchJson(url);
    if (!json) return { url: null, title: null, confidence: 0 };
    const crate = (json.crate ?? {}) as {
      documentation?: string;
      homepage?: string;
      description?: string;
    };
    const title = crate.description?.slice(0, 200) ?? name;
    if (crate.documentation) return { url: crate.documentation, title, confidence: 0.7 };
    if (crate.homepage) return { url: crate.homepage, title, confidence: 0.5 };
    return { url: `https://docs.rs/${name}`, title, confidence: 0.5 };
  }

  private async fetchPackagist(name: string): Promise<{ url: string | null; title: string | null; confidence: number }> {
    const url = `https://packagist.org/packages/${encodeURIComponent(name)}.json`;
    const json = await this.fetchJson(url);
    if (!json) return { url: null, title: null, confidence: 0 };
    const pkg = (json.package ?? {}) as { description?: string; repository?: string };
    const title = pkg.description?.slice(0, 200) ?? name;
    if (pkg.repository) return { url: normalizeGitUrl(pkg.repository), title, confidence: 0.45 };
    return { url: `https://packagist.org/packages/${name}`, title, confidence: 0.3 };
  }

  private async fetchRubygems(name: string): Promise<{ url: string | null; title: string | null; confidence: number }> {
    const url = `https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`;
    const json = await this.fetchJson(url);
    if (!json) return { url: null, title: null, confidence: 0 };
    const info = json as {
      documentation_uri?: string;
      homepage_uri?: string;
      info?: string;
      source_code_uri?: string;
    };
    const title = info.info?.slice(0, 200) ?? name;
    if (info.documentation_uri) return { url: info.documentation_uri, title, confidence: 0.7 };
    if (info.homepage_uri) return { url: info.homepage_uri, title, confidence: 0.5 };
    if (info.source_code_uri) return { url: info.source_code_uri, title, confidence: 0.45 };
    return { url: `https://rubygems.org/gems/${name}`, title, confidence: 0.3 };
  }

  // ─── Network helpers ─────────────────────────────────────────────

  private async fetchJson(url: string): Promise<Record<string, unknown> | null> {
    await this.throttleForHost(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const json = (await response.json()) as Record<string, unknown>;
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  private async throttleForHost(url: string): Promise<void> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return;
    }
    const last = hostLastCallAt.get(host) ?? 0;
    const now = Date.now();
    const waitMs = HOST_THROTTLE_MS - (now - last);
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    hostLastCallAt.set(host, Date.now());
  }

  // ─── Persistence ─────────────────────────────────────────────────

  /**
   * Pull all `doc_sources.uri` values so the scan can skip packages
   * whose canonical URL is already indexed (regardless of collection).
   */
  private listExistingDocSourceUrls(): Set<string> {
    const rows = this.opts.db
      .prepare('SELECT uri FROM doc_sources')
      .all() as Array<{ uri: string }>;
    return new Set(rows.map((r) => r.uri));
  }

  /**
   * INSERT OR IGNORE so re-scans don't overwrite a row the user previously
   * dismissed or approved. Returns `true` when a new row landed.
   */
  private persistSuggestion(projectId: number, s: DepSuggestion): boolean {
    const result = this.opts.db
      .prepare(
        `INSERT OR IGNORE INTO doc_source_suggestions (
           project_id, package_manager, package_name, package_version,
           suggested_url, suggested_title, confidence
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        s.package_manager,
        s.package_name,
        s.package_version,
        s.suggested_url,
        s.suggested_title,
        s.confidence,
      );
    return Number(result.changes) > 0;
  }
}

// ─── Utility helpers ────────────────────────────────────────────────

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function stripVersionPrefix(v: string): string {
  // Strip caret/tilde/equal range operators commonly seen in manifests:
  //   "^1.2.3" → "1.2.3", "~1.2.3" → "1.2.3", "git+ssh://…" → as-is.
  return v.replace(/^[\^~=><]+/, '').trim() || v.trim();
}

function normalizeGitUrl(url: string): string {
  // Convert "git+https://github.com/x/y.git" → "https://github.com/x/y".
  let normalized = url.trim();
  if (normalized.startsWith('git+')) normalized = normalized.slice(4);
  if (normalized.endsWith('.git')) normalized = normalized.slice(0, -4);
  return normalized;
}
