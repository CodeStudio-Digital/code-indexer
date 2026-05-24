import ts from 'typescript';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, isAbsolute, dirname, join } from 'node:path';

/**
 * TypeScript canonical path: forward slashes only, lowercase Windows
 * drive letter. The TS compiler stores file names this way internally
 * (`ts.sys.useCaseSensitiveFileNames` is false on Windows but the path
 * shape matters for our own .has()/Map lookups).
 *
 * Examples:
 *   "D:\\MCP\\foo.ts"  → "d:/MCP/foo.ts"
 *   "/D:/MCP/foo.ts"   → "d:/MCP/foo.ts"   (Monaco URI form on Windows)
 *   "/usr/local/x.ts"  → "/usr/local/x.ts" (POSIX unchanged)
 */
function tsCanonical(p: string): string {
  // Strip leading slash that Monaco URIs add to Windows paths
  // (file:///D:/foo.ts → /D:/foo.ts).
  let cleaned = p;
  if (/^\/[a-zA-Z]:[\\/]/.test(cleaned)) cleaned = cleaned.slice(1);
  const abs = isAbsolute(cleaned) ? cleaned : resolve(cleaned);
  return abs
    .split('\\')
    .join('/')
    .replace(/^([a-zA-Z]):/, (_m, d: string) => d.toLowerCase() + ':');
}

/**
 * In-process TypeScript language service.
 *
 * This is "LSP Phase 2" from the implementation plan. Instead of spawning a
 * full language server over stdio, we use the TypeScript Compiler API (which
 * is already a dependency) directly. Functionally equivalent for our tools
 * (definitions, references, hover, diagnostics) and ~10x faster because
 * there's no IPC overhead and the project's program is kept warm in-process.
 *
 * One `TsLanguageService` per project root, lazy-initialised on first use
 * and reused across tool calls in the same session. File contents are read
 * from disk on demand; versioning is mtime-based, so edits made via
 * write_file/edit_file are picked up automatically on the next tool call.
 */

export interface TsPosition {
  /**
   * Absolute file path in TS-canonical form (forward slashes, lowercase
   * drive letter on Windows). Absolute so the IDE renderer can build a
   * `monaco.Uri.file(...)` directly — relative paths don't round-trip
   * through `monaco.Uri.parse` (the first segment becomes the URI scheme).
   */
  file: string;
  /** 1-based line number (what agents/users see in editors). */
  line: number;
  /** 1-based column. */
  column: number;
}

export interface DefinitionResult {
  targets: TsPosition[];
}

export interface ReferenceResult {
  references: Array<TsPosition & { isWriteAccess?: boolean }>;
}

export interface HoverResult {
  displayString: string;
  documentation: string;
  kind: string;
}

export interface DiagnosticResult {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  code: number;
  message: string;
}

export class TsLanguageService {
  private readonly projectRoot: string;
  private readonly files = new Map<string, { version: string; content: string }>();
  private service: ts.LanguageService | null = null;
  private rootFiles: string[] = [];
  private compilerOptions: ts.CompilerOptions;

  constructor(projectRoot: string) {
    this.projectRoot = tsCanonical(projectRoot);
    this.compilerOptions = this.loadCompilerOptions();
  }

  private loadCompilerOptions(): ts.CompilerOptions {
    const configPath = ts.findConfigFile(this.projectRoot, ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) {
      // Sensible defaults if the project has no tsconfig — unusual but possible.
      return {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowJs: true,
        checkJs: false,
        esModuleInterop: true,
        skipLibCheck: true,
      };
    }
    return this.loadAndExpandConfig(configPath);
  }

  /**
   * Load a tsconfig + walk its `references` (and the referenced configs'
   * references, recursively). Vite/Angular/Solid scaffolds emit a thin
   * tsconfig.json that only contains `{ files: [], references: [...] }`,
   * pointing at tsconfig.app.json + tsconfig.node.json. Without expansion
   * the LSP sees zero rootFiles → every import fails with "Cannot find
   * module" and completion goes silent.
   *
   * Merge strategy: deduplicate rootFiles by absolute path, and use the
   * compilerOptions of the FIRST config that has real options (skipping
   * the empty composite root). Path mappings (`paths`, `baseUrl`) carry
   * with the chosen options.
   */
  private loadAndExpandConfig(rootConfigPath: string): ts.CompilerOptions {
    const seen = new Set<string>();
    const allFiles = new Set<string>();
    const candidateOptions: ts.CompilerOptions[] = [];

    const visit = (configPath: string): void => {
      const norm = resolve(configPath);
      if (seen.has(norm)) return;
      seen.add(norm);

      const { config, error } = ts.readConfigFile(norm, ts.sys.readFile);
      if (error || !config) return;
      const parsed = ts.parseJsonConfigFileContent(
        config,
        ts.sys,
        dirname(norm),
        undefined,
        norm,
      );
      // Normalize so .has()/.includes() against canonical paths matches.
      for (const f of parsed.fileNames) allFiles.add(tsCanonical(f));
      if (
        parsed.options &&
        Object.keys(parsed.options).length > 0 &&
        // Skip the synthetic option set the parser fills in for empty
        // configs — heuristic: a real options block has compilerOptions
        // beyond `configFilePath`.
        Object.keys(parsed.options).some((k) => k !== 'configFilePath')
      ) {
        candidateOptions.push(parsed.options);
      }

      // Walk references. Each reference can point at a config file OR a
      // directory containing one — match TS's own resolver behaviour.
      for (const ref of parsed.projectReferences ?? []) {
        const refPath = ref.path;
        let candidate = resolve(dirname(norm), refPath);
        try {
          const stat = statSync(candidate);
          if (stat.isDirectory()) {
            candidate = join(candidate, 'tsconfig.json');
          }
        } catch {
          /* stat failed — try as-is */
        }
        if (existsSync(candidate)) visit(candidate);
      }
    };

    visit(rootConfigPath);
    this.rootFiles = Array.from(allFiles);

    // Prefer the first non-empty options set (typically tsconfig.app.json).
    // Fall back to a permissive default that won't reject every import.
    if (candidateOptions.length > 0) {
      return candidateOptions[0];
    }
    return {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: true,
      checkJs: false,
      esModuleInterop: true,
      skipLibCheck: true,
      jsx: ts.JsxEmit.Preserve,
    };
  }

  private ensureService(): ts.LanguageService {
    if (this.service) return this.service;
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => {
        const set = new Set([...this.rootFiles, ...this.files.keys()]);
        return Array.from(set);
      },
      getScriptVersion: (fileName) => {
        const cached = this.files.get(fileName);
        if (cached) return cached.version;
        try {
          return String(statSync(fileName).mtimeMs);
        } catch {
          return '0';
        }
      },
      getScriptSnapshot: (fileName) => {
        const cached = this.files.get(fileName);
        if (cached) return ts.ScriptSnapshot.fromString(cached.content);
        if (!existsSync(fileName)) return undefined;
        try {
          const content = readFileSync(fileName, 'utf-8');
          return ts.ScriptSnapshot.fromString(content);
        } catch {
          return undefined;
        }
      },
      getCurrentDirectory: () => this.projectRoot,
      getCompilationSettings: () => this.compilerOptions,
      getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
    return this.service;
  }

  // ── Path helpers ─────────────────────────────

  /**
   * Accept either a project-relative path, a backslash-Windows path, or
   * a Monaco-style `/D:/...` URI path. Always returns the canonical
   * absolute form (forward slashes, lowercase drive letter on Windows).
   *
   * This is THE choke point that prevented Ctrl+Click from working:
   * Monaco was sending `D:/MCP/foo.ts` (from `model.uri.path.replace`),
   * `rootFiles` held `D:\MCP\foo.ts` (from `parseJsonConfigFileContent`
   * on Windows), and `getDefinitionAtPosition` did string-equal lookups
   * → never matched → empty result → "only self" in the UI.
   */
  private toAbs(filePath: string): string {
    if (isAbsolute(filePath) || /^\/[a-zA-Z]:[\\/]/.test(filePath)) {
      return tsCanonical(filePath);
    }
    return tsCanonical(resolve(this.projectRoot, filePath));
  }

  /**
   * If the file isn't already known to the language service, add it as
   * a synthetic root and force the next call to rebuild the program.
   *
   * Why: `loadAndExpandConfig` pulls rootFiles from tsconfig.include —
   * but the user can open ANY file in the editor (a one-off script, a
   * test the include forgot, a file in another package). The first
   * lookup against an "unknown" file used to return empty; now it
   * rebuilds with the file included. Cost: ~200ms on first hit, free
   * thereafter (the registry caches).
   */
  private ensureFileTracked(absCanonical: string): void {
    if (this.rootFiles.includes(absCanonical)) return;
    if (this.files.has(absCanonical)) return;
    if (!existsSync(absCanonical)) return;
    this.rootFiles = [...this.rootFiles, absCanonical];
    // Tear down so the next ensureService() rebuilds with the new root.
    this.service?.dispose();
    this.service = null;
  }

  /** Convert (line, col) → absolute character offset using live file content. */
  private positionToOffset(fileAbs: string, line: number, column: number): number | null {
    let content: string;
    try {
      content = readFileSync(fileAbs, 'utf-8');
    } catch {
      return null;
    }
    // 1-based line/col → 0-based offset.
    const lines = content.split('\n');
    if (line < 1 || line > lines.length) return null;
    let offset = 0;
    for (let i = 0; i < line - 1; i++) offset += lines[i].length + 1; // +1 for \n
    offset += Math.max(0, column - 1);
    return offset;
  }

  /** Convert absolute offset → (line, col). */
  private offsetToPosition(fileAbs: string, offset: number): { line: number; column: number } {
    let content: string;
    try {
      content = readFileSync(fileAbs, 'utf-8');
    } catch {
      return { line: 1, column: 1 };
    }
    let line = 1;
    let col = 1;
    for (let i = 0; i < offset && i < content.length; i++) {
      if (content[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
    }
    return { line, column: col };
  }

  // ── Public API used by tools ──────────────────

  getDefinition(file: string, line: number, column: number): DefinitionResult {
    const abs = this.toAbs(file);
    this.ensureFileTracked(abs);
    const service = this.ensureService();
    const offset = this.positionToOffset(abs, line, column);
    if (offset === null) return { targets: [] };
    const defs = service.getDefinitionAtPosition(abs, offset) ?? [];
    const targets: TsPosition[] = [];
    for (const d of defs) {
      const pos = this.offsetToPosition(d.fileName, d.textSpan.start);
      targets.push({ file: tsCanonical(d.fileName), line: pos.line, column: pos.column });
    }
    return { targets };
  }

  getReferences(file: string, line: number, column: number): ReferenceResult {
    const abs = this.toAbs(file);
    this.ensureFileTracked(abs);
    const service = this.ensureService();
    const offset = this.positionToOffset(abs, line, column);
    if (offset === null) return { references: [] };
    const refs = service.getReferencesAtPosition(abs, offset) ?? [];
    const references = refs.map((r) => {
      const pos = this.offsetToPosition(r.fileName, r.textSpan.start);
      return {
        file: tsCanonical(r.fileName),
        line: pos.line,
        column: pos.column,
        isWriteAccess: r.isWriteAccess,
      };
    });
    return { references };
  }

  getHover(file: string, line: number, column: number): HoverResult | null {
    const abs = this.toAbs(file);
    this.ensureFileTracked(abs);
    const service = this.ensureService();
    const offset = this.positionToOffset(abs, line, column);
    if (offset === null) return null;
    const info = service.getQuickInfoAtPosition(abs, offset);
    if (!info) return null;
    const displayString = ts.displayPartsToString(info.displayParts);
    const documentation = ts.displayPartsToString(info.documentation);
    return {
      displayString,
      documentation,
      kind: info.kind,
    };
  }

  getDiagnostics(file: string): DiagnosticResult[] {
    const abs = this.toAbs(file);
    this.ensureFileTracked(abs);
    const service = this.ensureService();
    const syntactic = service.getSyntacticDiagnostics(abs);
    const semantic = service.getSemanticDiagnostics(abs);
    const all: DiagnosticResult[] = [];
    for (const d of [...syntactic, ...semantic]) {
      let fileOut = abs;
      let line = 0;
      let column = 0;
      if (d.file && d.start !== undefined) {
        fileOut = tsCanonical(d.file.fileName);
        const pos = this.offsetToPosition(d.file.fileName, d.start);
        line = pos.line;
        column = pos.column;
      }
      const severity: DiagnosticResult['severity'] =
        d.category === ts.DiagnosticCategory.Error
          ? 'error'
          : d.category === ts.DiagnosticCategory.Warning
            ? 'warning'
            : 'info';
      all.push({
        file: fileOut,
        line,
        column,
        severity,
        code: d.code,
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      });
    }
    return all;
  }

  /**
   * Completion suggestions at a position. Used by the IDE workspace's
   * Monaco editor via the `lsp.completion` api-bus handler (debounced
   * ~300ms client-side). Returns the raw TS API entries plus a trimmed
   * `detail` so the Monaco render is cheap; consumers fetch full details
   * via a follow-up call only when the user hovers an entry.
   */
  getCompletions(file: string, line: number, column: number): CompletionEntry[] {
    const abs = this.toAbs(file);
    this.ensureFileTracked(abs);
    const service = this.ensureService();
    const offset = this.positionToOffset(abs, line, column);
    if (offset === null) return [];
    const result = service.getCompletionsAtPosition(abs, offset, {
      includeCompletionsWithInsertText: true,
      includeCompletionsForModuleExports: true,
      triggerKind: ts.CompletionTriggerKind.Invoked,
    });
    if (!result) return [];
    return result.entries.map((e) => ({
      name: e.name,
      kind: String(e.kind),
      sortText: e.sortText,
      insertText: e.insertText ?? e.name,
      isSnippet: !!e.isSnippet,
      // `detail` — short, cheap descriptor. For full info the caller
      // hits `getQuickInfoAtPosition` (lsp.hover).
      detail: e.kindModifiers || undefined,
    }));
  }

  /** Drop internal caches. Called when the process shuts down or project root changes. */
  dispose(): void {
    this.service?.dispose();
    this.service = null;
    this.files.clear();
  }
}

export interface CompletionEntry {
  name: string;
  kind: string;
  sortText: string;
  insertText: string;
  isSnippet: boolean;
  detail?: string;
}

// ── Module-level cache with idle-timeout eviction ────

/**
 * Idle timeout (ms) before an unused TsLanguageService is disposed.
 * A full TS program graph can consume 500 MB-2 GB, so keeping services
 * alive indefinitely is the #1 contributor to heap OOM. Default: 5 min.
 */
const TS_SERVICE_IDLE_MS = Number(process.env.TS_SERVICE_IDLE_MS ?? 5 * 60_000);

interface CachedService {
  svc: TsLanguageService;
  timer: ReturnType<typeof setTimeout>;
}

const services = new Map<string, CachedService>();

function touchService(key: string, entry: CachedService): void {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.svc.dispose();
    services.delete(key);
  }, TS_SERVICE_IDLE_MS);
  entry.timer.unref();
}

export function getTsService(projectRoot: string): TsLanguageService {
  // Canonicalise so callers passing "D:\\MCP" and "d:/MCP" share one service
  // instead of double-loading the program (~500MB-2GB per duplicate).
  const key = tsCanonical(projectRoot);
  let entry = services.get(key);
  if (!entry) {
    const svc = new TsLanguageService(key);
    entry = {
      svc,
      timer: setTimeout(() => {
        svc.dispose();
        services.delete(key);
      }, TS_SERVICE_IDLE_MS),
    };
    entry.timer.unref();
    services.set(key, entry);
  } else {
    touchService(key, entry);
  }
  return entry.svc;
}

/** Dispose all cached services (for graceful shutdown). */
export function disposeAllTsServices(): void {
  for (const [key, entry] of services) {
    clearTimeout(entry.timer);
    entry.svc.dispose();
    services.delete(key);
  }
}

/** Supported file extensions for LSP tools. */
export function isTsFile(file: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(file);
}

