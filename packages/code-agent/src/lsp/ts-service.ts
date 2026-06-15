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
 * True when a canonical path lives under the indexer's private working
 * dir (`.mcp-indexer/`, which holds the trash bin and `.tmp` scratch
 * files the doc-indexer writes-then-deletes). These are ephemeral
 * implementation details and must never enter the TS program — otherwise
 * a deleted `.mcp-indexer/trash/.../.tmp/*.cjs` lingers as a phantom root
 * and `getDiagnostics` spams "Could not find source file" forever.
 */
function isIndexerInternalPath(canonical: string): boolean {
  return /(^|\/)\.mcp-indexer(\/|$)/.test(canonical);
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
    const base = candidateOptions.length > 0
      ? candidateOptions[0]
      : {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          allowJs: true,
          checkJs: false,
          esModuleInterop: true,
          skipLibCheck: true,
          jsx: ts.JsxEmit.Preserve,
        };

    // Critical safety net: if the chosen tsconfig didn't set
    // `moduleResolution` explicitly, the TS Compiler API silently
    // falls back to `Classic`, which does NOT look in node_modules.
    // The user's error — "Cannot find module '@angular/core'" — is
    // a textbook symptom of that. Pick a sensible default based on
    // the module setting so the project at least RESOLVES even if
    // its tsconfig was written for the bundler to override later.
    if (base.moduleResolution === undefined) {
      const mod = base.module;
      base.moduleResolution =
        mod === ts.ModuleKind.CommonJS
          ? ts.ModuleResolutionKind.Node10
          : ts.ModuleResolutionKind.Bundler;
    }
    // Defaults Angular/Vite/Next users always want — flipping these
    // here is forgiving: if a project deliberately disabled them,
    // they can flip back via their own tsconfig because we never
    // OVERRIDE explicit `false`, only fill in `undefined`.
    if (base.esModuleInterop === undefined) base.esModuleInterop = true;
    if (base.allowSyntheticDefaultImports === undefined) base.allowSyntheticDefaultImports = true;
    if (base.skipLibCheck === undefined) base.skipLibCheck = true;

    return base;
  }

  /**
   * Public diagnose helper — returns enough info to debug "Cannot find
   * module" errors without recompiling the backend. Callable via the
   * `lsp.diagnose` IPC handler (or directly from tests). Output is
   * intentionally JSON-serialisable.
   */
  diagnose(file?: string): {
    projectRoot: string;
    tsconfigPath: string | null;
    compilerOptions: Record<string, unknown>;
    rootFilesCount: number;
    rootFilesSample: string[];
    nodeModulesPresent: boolean;
    angularCorePresent: boolean;
    resolveAngularCore: {
      resolvedFileName: string | null;
      isExternalLibraryImport: boolean | null;
      failedLookupLocationsSample: string[];
    } | null;
  } {
    const configPath = ts.findConfigFile(this.projectRoot, ts.sys.fileExists, 'tsconfig.json');
    const nodeModules = `${this.projectRoot}/node_modules`;
    const angularCore = `${nodeModules}/@angular/core`;
    const sampleFile = file
      ? this.toAbs(file)
      : this.rootFiles[0] ?? `${this.projectRoot}/index.ts`;

    let resolveAngularCore: ReturnType<typeof this.diagnose>['resolveAngularCore'] = null;
    try {
      const resolved = ts.resolveModuleName(
        '@angular/core',
        sampleFile,
        this.compilerOptions,
        {
          fileExists: ts.sys.fileExists,
          readFile: ts.sys.readFile,
          directoryExists: ts.sys.directoryExists,
          getCurrentDirectory: () => this.projectRoot,
          getDirectories: ts.sys.getDirectories,
          realpath: ts.sys.realpath,
          useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
        },
      );
      // failedLookupLocations is internal to the TS compiler but
      // documented in source — typed `unknown` to avoid the d.ts
      // surface being out of step.
      const failed =
        (resolved as unknown as { failedLookupLocations?: string[] }).failedLookupLocations ?? [];
      resolveAngularCore = {
        resolvedFileName: resolved.resolvedModule?.resolvedFileName ?? null,
        isExternalLibraryImport: resolved.resolvedModule?.isExternalLibraryImport ?? null,
        failedLookupLocationsSample: failed.slice(0, 8),
      };
    } catch (e) {
      resolveAngularCore = {
        resolvedFileName: null,
        isExternalLibraryImport: null,
        failedLookupLocationsSample: [`<resolveModuleName threw: ${e instanceof Error ? e.message : String(e)}>`],
      };
    }

    return {
      projectRoot: this.projectRoot,
      tsconfigPath: configPath ?? null,
      compilerOptions: {
        target: this.compilerOptions.target,
        module: this.compilerOptions.module,
        moduleResolution: this.compilerOptions.moduleResolution,
        baseUrl: this.compilerOptions.baseUrl,
        paths: this.compilerOptions.paths,
        esModuleInterop: this.compilerOptions.esModuleInterop,
        allowSyntheticDefaultImports: this.compilerOptions.allowSyntheticDefaultImports,
        skipLibCheck: this.compilerOptions.skipLibCheck,
        jsx: this.compilerOptions.jsx,
        types: this.compilerOptions.types,
        typeRoots: this.compilerOptions.typeRoots,
      },
      rootFilesCount: this.rootFiles.length,
      rootFilesSample: this.rootFiles.slice(0, 5),
      nodeModulesPresent: existsSync(nodeModules),
      angularCorePresent: existsSync(angularCore),
      resolveAngularCore,
    };
  }

  private ensureService(): ts.LanguageService {
    if (this.service) {
      return this.service;
    }
    // One-shot debug log per project. The "ignored node_modules" class
    // of bugs almost always traces back to either (a) the chosen
    // tsconfig didn't have node_modules in its resolver path, (b) the
    // user has no node_modules on disk, or (c) a paths/baseUrl mapping
    // is shadowing the real package. This block surfaces all three at
    // a glance the first time the service is built.
    try {
      const diag = this.diagnose();
      console.log(
        '[lsp] service init',
        JSON.stringify(
          {
            projectRoot: diag.projectRoot,
            tsconfigPath: diag.tsconfigPath,
            moduleResolution: diag.compilerOptions.moduleResolution,
            module: diag.compilerOptions.module,
            baseUrl: diag.compilerOptions.baseUrl,
            pathsKeys: diag.compilerOptions.paths
              ? Object.keys(diag.compilerOptions.paths as object)
              : null,
            rootFilesCount: diag.rootFilesCount,
            nodeModulesPresent: diag.nodeModulesPresent,
            angularCorePresent: diag.angularCorePresent,
            resolvedAngularCore: diag.resolveAngularCore?.resolvedFileName,
            failedLookupsSample:
              diag.resolveAngularCore?.resolvedFileName === null
                ? diag.resolveAngularCore.failedLookupLocationsSample
                : undefined,
          },
          null,
          2,
        ),
      );
    } catch (e) {
      console.warn('[lsp] diagnose failed:', e);
    }

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
        // TS may call with the path it received from getScriptFileNames
        // OR with a slightly different shape after its own canonicalization
        // (mixed case on Windows, etc.). Try the canonical form too.
        const canonical = tsCanonical(fileName);
        const cached = this.files.get(fileName) ?? this.files.get(canonical);
        if (cached) return ts.ScriptSnapshot.fromString(cached.content);
        // Don't gate on existsSync — readFileSync throws cleanly when the
        // file's missing and gives the content for free when present.
        try {
          const content = readFileSync(fileName, 'utf-8');
          return ts.ScriptSnapshot.fromString(content);
        } catch {
          try {
            const content = readFileSync(canonical, 'utf-8');
            return ts.ScriptSnapshot.fromString(content);
          } catch {
            return undefined;
          }
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
      // Case-sensitivity: the default behaviour of `ts.sys` is what
      // every other TS consumer (tsc, vscode) uses on the same OS.
      // Explicitly forwarding it stops the LanguageService from
      // defaulting to true on Windows, which would cause case-mismatch
      // lookups against the on-disk drive letter.
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      // CRITICAL for pnpm: `node_modules/@angular/core` is a symlink
      // pointing into `node_modules/.pnpm/@angular+core@…/node_modules/`.
      // Without realpath, TypeScript walks the literal symlink and
      // can't follow nested imports inside the package's own bundle,
      // which surfaces as "Cannot find module '@angular/core'" even
      // when the file physically exists. `ts.sys.realpath` uses
      // fs.realpathSync.native and is the same one tsc relies on.
      realpath: ts.sys.realpath,
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
  /**
   * Push the live editor buffer into the language-service host so
   * subsequent calls see the unsaved text. Used by the IDE editor on
   * every keystroke (debounced via the LSP request itself, not here).
   *
   * Behaviour:
   *   - First call for a file: adds to rootFiles AND files snapshot map.
   *   - Subsequent calls: only updates content + bumps version so the TS
   *     LanguageService incrementally re-parses the file. No service
   *     teardown — that would force a full Program rebuild on every
   *     keystroke and kill latency.
   *   - No-op when content matches the cached version (cheap dedupe).
   */
  setFileSnapshot(file: string, content: string): void {
    const abs = this.toAbs(file);
    // Never track indexer scratch/trash — see isIndexerInternalPath.
    if (isIndexerInternalPath(abs)) return;
    const cached = this.files.get(abs);
    if (cached && cached.content === content) return;
    const nextVersion = String((cached ? Number(cached.version) : 0) + 1);
    this.files.set(abs, { version: nextVersion, content });
    // Make sure the program knows about this file as a root if it
    // wasn't already; otherwise getCompletionsAtPosition will throw
    // "Could not find source file".
    if (!this.rootFiles.includes(abs)) {
      this.rootFiles = [...this.rootFiles, abs];
      this.service?.dispose();
      this.service = null;
    }
  }

  /**
   * Remove a path from the program's root set + snapshot map and tear the
   * service down so the next `ensureService()` rebuilds without it. Called
   * when a tracked file has vanished from disk (deleted/trashed) — without
   * this the stale root keeps throwing "Could not find source file" on
   * every diagnostics poll. Mirrors the teardown idiom in setFileSnapshot.
   */
  private untrack(absCanonical: string): void {
    const inRoots = this.rootFiles.includes(absCanonical);
    const inFiles = this.files.delete(absCanonical);
    if (inRoots) this.rootFiles = this.rootFiles.filter((f) => f !== absCanonical);
    if (inRoots || inFiles) {
      this.service?.dispose();
      this.service = null;
    }
  }

  private ensureFileTracked(absCanonical: string): void {
    if (isIndexerInternalPath(absCanonical)) return;
    if (this.rootFiles.includes(absCanonical)) return;
    if (this.files.has(absCanonical)) return;
    // Use readFileSync (not existsSync) as the existence probe — it
    // gives us the content for free AND defeats any case-sensitivity
    // quirk in stat/exists calls. If the read fails the file is
    // genuinely missing (deleted/permission denied) and there's
    // nothing useful we can do.
    let content: string;
    try {
      content = readFileSync(absCanonical, 'utf-8');
    } catch (e) {
      console.warn(
        `[lsp] ensureFileTracked: cannot read ${absCanonical} (${e instanceof Error ? e.message : String(e)}). Skipping.`,
      );
      return;
    }
    // Pre-populate BOTH rootFiles AND the `files` snapshot map. Having
    // a fresh snapshot in the map means the LanguageServiceHost's
    // getScriptSnapshot returns content immediately without re-reading
    // disk on every call — and shields us from races where the disk
    // copy is mid-write when the program is built.
    this.rootFiles = [...this.rootFiles, absCanonical];
    this.files.set(absCanonical, {
      version: String(Date.now()),
      content,
    });
    // Tear down so the next ensureService() rebuilds with the new root.
    this.service?.dispose();
    this.service = null;
  }

  /**
   * Convert (line, col) → absolute character offset.
   *
   * Critical: prefer the in-memory snapshot from `this.files` over the
   * on-disk copy. When the editor pushes live content via
   * `setFileSnapshot`, that map holds the user's current buffer (with
   * unsaved keystrokes). Reading from disk would give a stale version
   * and produce off-by-N offsets right after the user types a `.`,
   * which is exactly when completion needs to fire.
   */
  private positionToOffset(fileAbs: string, line: number, column: number): number | null {
    const cached = this.files.get(fileAbs);
    let content: string;
    if (cached) {
      content = cached.content;
    } else {
      try {
        content = readFileSync(fileAbs, 'utf-8');
      } catch {
        return null;
      }
    }
    // 1-based line/col → 0-based offset.
    const lines = content.split('\n');
    if (line < 1 || line > lines.length) return null;
    let offset = 0;
    for (let i = 0; i < line - 1; i++) offset += lines[i].length + 1; // +1 for \n
    offset += Math.max(0, column - 1);
    return offset;
  }

  /** Convert absolute offset → (line, col). Mirrors positionToOffset's
   *  cache-first lookup so error-location math stays consistent with
   *  the buffer the user actually sees. */
  private offsetToPosition(fileAbs: string, offset: number): { line: number; column: number } {
    const cached = this.files.get(fileAbs);
    let content: string;
    if (cached) {
      content = cached.content;
    } else {
      try {
        content = readFileSync(fileAbs, 'utf-8');
      } catch {
        return { line: 1, column: 1 };
      }
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
    let defs: readonly ts.DefinitionInfo[];
    try {
      defs = service.getDefinitionAtPosition(abs, offset) ?? [];
    } catch (e) {
      console.warn(
        `[lsp] getDefinition: ${e instanceof Error ? e.message : String(e)} (file=${abs})`,
      );
      return { targets: [] };
    }
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
    let refs: readonly ts.ReferenceEntry[];
    try {
      refs = service.getReferencesAtPosition(abs, offset) ?? [];
    } catch (e) {
      console.warn(
        `[lsp] getReferences: ${e instanceof Error ? e.message : String(e)} (file=${abs})`,
      );
      return { references: [] };
    }
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
    let info: ts.QuickInfo | undefined;
    try {
      info = service.getQuickInfoAtPosition(abs, offset);
    } catch (e) {
      console.warn(
        `[lsp] getHover: ${e instanceof Error ? e.message : String(e)} (file=${abs})`,
      );
      return null;
    }
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
    // Self-heal: a path that's an indexer-internal scratch file, or that no
    // longer exists on disk (deleted/trashed) AND has no live in-memory
    // snapshot to serve, must not be fed to the language service — it would
    // throw "Could not find source file" on every 1 s diagnostics poll.
    // Prune it once and return clean. (An unsaved buffer lives in `files`,
    // so we still diagnose those even when absent from disk.)
    if (isIndexerInternalPath(abs) || (!this.files.has(abs) && !existsSync(abs))) {
      this.untrack(abs);
      return [];
    }
    this.ensureFileTracked(abs);
    const service = this.ensureService();
    // The TS LanguageService will throw `Could not find source file: <path>`
    // when the path we pass isn't in the current Program. That can happen
    // when the user edits a file the indexer hasn't yet observed, when
    // the project rebuilds mid-call, or when paths drift after a rename.
    // Surface it as zero diagnostics instead of a spammy crash trace.
    let syntactic: readonly ts.Diagnostic[];
    let semantic: readonly ts.Diagnostic[];
    try {
      syntactic = service.getSyntacticDiagnostics(abs);
      semantic = service.getSemanticDiagnostics(abs);
    } catch (e) {
      console.warn(
        `[lsp] getDiagnostics: ${e instanceof Error ? e.message : String(e)} (file=${abs})`,
      );
      return [];
    }
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
    let result: ts.CompletionInfo | undefined;
    try {
      result = service.getCompletionsAtPosition(abs, offset, {
        includeCompletionsWithInsertText: true,
        includeCompletionsForModuleExports: true,
        triggerKind: ts.CompletionTriggerKind.Invoked,
      });
    } catch (e) {
      console.warn(
        `[lsp] getCompletions: ${e instanceof Error ? e.message : String(e)} (file=${abs})`,
      );
      return [];
    }
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

  /**
   * Semantic-token classifications for an entire file. Drives the
   * Monaco semantic-token provider — Monaco's own TS worker doesn't
   * know about node_modules / tsconfig, so we own this.
   *
   * Returns LSP-style delta-encoded numbers in groups of 5:
   *   [ deltaLine, deltaStartChar, length, tokenType, tokenModifiers ]
   *
   * The legend the renderer declares must match the indices we emit
   * here. See SEMANTIC_TOKEN_TYPES / SEMANTIC_TOKEN_MODIFIERS below.
   */
  getSemanticTokens(file: string): number[] {
    const abs = this.toAbs(file);
    this.ensureFileTracked(abs);
    const service = this.ensureService();

    // Read the file content from our cached snapshot (live editor buffer
    // when present) so the offset → line/char math matches what the
    // user sees on screen.
    const cached = this.files.get(abs);
    let content: string;
    if (cached) content = cached.content;
    else {
      try { content = readFileSync(abs, 'utf-8'); }
      catch { return []; }
    }

    // Precompute line-start offsets so offsetToLineChar() is O(log n)
    // per span instead of O(n) — files with thousands of tokens would
    // otherwise spend visible time here.
    const lineStarts: number[] = [0];
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') lineStarts.push(i + 1);
    }
    const offsetToLineChar = (offset: number): [number, number] => {
      // Binary search for the line whose start is the greatest value ≤ offset.
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (lineStarts[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return [lo, offset - lineStarts[lo]];
    };

    let classifications: ts.Classifications;
    try {
      classifications = service.getEncodedSemanticClassifications(
        abs,
        { start: 0, length: content.length },
        ts.SemanticClassificationFormat.TwentyTwenty,
      );
    } catch (e) {
      console.warn(
        `[lsp] getSemanticTokens: ${e instanceof Error ? e.message : String(e)} (file=${abs})`,
      );
      return [];
    }

    // `spans` is a flat number[] in triples [start, length, classification].
    // `classification` packs (tokenType << TokenEncodingConsts.typeOffset) |
    // tokenModifierSet — we mirror the same shift to recover the type.
    // The TS source defines TokenEncodingConsts.typeOffset = 8 — we
    // hardcode it (the const isn't exported on the public type surface).
    const TS_TYPE_OFFSET = 8;
    const TS_MOD_MASK = (1 << TS_TYPE_OFFSET) - 1;

    const spans = classifications.spans;
    const out: number[] = [];
    let prevLine = 0;
    let prevChar = 0;
    for (let i = 0; i < spans.length; i += 3) {
      const start = spans[i];
      const length = spans[i + 1];
      const cls = spans[i + 2];
      const tsType = cls >> TS_TYPE_OFFSET;
      const tsMods = cls & TS_MOD_MASK;
      const lspType = TS_TYPE_TO_LSP_INDEX[tsType];
      if (lspType === undefined) continue;
      const lspMods = mapTsModifiersToLsp(tsMods);
      const [line, char] = offsetToLineChar(start);
      // Delta-encode against previous emitted token (LSP spec).
      const deltaLine = line - prevLine;
      const deltaChar = deltaLine === 0 ? char - prevChar : char;
      out.push(deltaLine, deltaChar, length, lspType, lspMods);
      prevLine = line;
      prevChar = char;
    }
    return out;
  }

  /** Drop internal caches. Called when the process shuts down or project root changes. */
  dispose(): void {
    this.service?.dispose();
    this.service = null;
    this.files.clear();
  }
}

// ── Semantic-token legend ────────────────────────────────────────
//
// The frontend declares the EXACT same legend when registering the
// Monaco provider. Order matters — these arrays are indexed by the
// numbers we emit in `getSemanticTokens`.

/**
 * LSP semantic token types we publish. Matches the standard names
 * VS Code's default themes already have rules for, so colours appear
 * out of the box.
 */
export const SEMANTIC_TOKEN_TYPES = [
  'class',         // 0
  'enum',          // 1
  'interface',     // 2
  'namespace',     // 3
  'typeParameter', // 4
  'type',          // 5
  'parameter',     // 6
  'variable',      // 7
  'enumMember',    // 8
  'property',      // 9
  'function',      // 10
  'method',        // 11
] as const;

export const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration',    // 0  bit 1
  'static',         // 1  bit 2
  'async',          // 2  bit 4
  'readonly',       // 3  bit 8
  'defaultLibrary', // 4  bit 16
  'local',          // 5  bit 32
] as const;

/**
 * Map TypeScript's ClassificationType (2020 format) → LSP type index.
 * The TS enum values (in `ts.ClassificationType`) line up 0..11 with
 * the legend above. Anything outside that range is dropped (returns
 * undefined → the for-loop skips it).
 *
 * Numeric values come from the TypeScript source — they're stable
 * across versions because the encoded classification protocol is
 * public API surface.
 */
const TS_TYPE_TO_LSP_INDEX: Record<number, number | undefined> = {
  0: 0,  // class
  1: 1,  // enum
  2: 2,  // interface
  3: 3,  // namespace (module)
  4: 4,  // typeParameter
  5: 5,  // type
  6: 6,  // parameter
  7: 7,  // variable
  8: 8,  // enumMember
  9: 9,  // property
  10: 10, // function
  11: 11, // method
};

/**
 * Map TS modifier bitset → LSP modifier bitset. TS bits (per the
 * TokenModifier enum) line up 1:1 with our legend's bit positions,
 * so it's an identity copy. Kept as a function for clarity and so
 * we can adjust if TS shifts bits between versions.
 */
function mapTsModifiersToLsp(tsMods: number): number {
  return tsMods;
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

