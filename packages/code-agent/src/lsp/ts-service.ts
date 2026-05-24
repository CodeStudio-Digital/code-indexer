import ts from 'typescript';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';

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
  /** Project-relative path. */
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
    this.projectRoot = resolve(projectRoot);
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
    const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(configPath));
    this.rootFiles = parsed.fileNames;
    return parsed.options;
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

  private toAbs(filePath: string): string {
    return isAbsolute(filePath) ? filePath : resolve(this.projectRoot, filePath);
  }

  private toRel(abs: string): string {
    const rel = relative(this.projectRoot, abs);
    return rel.split('\\').join('/');
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
    const service = this.ensureService();
    const abs = this.toAbs(file);
    const offset = this.positionToOffset(abs, line, column);
    if (offset === null) return { targets: [] };
    const defs = service.getDefinitionAtPosition(abs, offset) ?? [];
    const targets: TsPosition[] = [];
    for (const d of defs) {
      const pos = this.offsetToPosition(d.fileName, d.textSpan.start);
      targets.push({ file: this.toRel(d.fileName), line: pos.line, column: pos.column });
    }
    return { targets };
  }

  getReferences(file: string, line: number, column: number): ReferenceResult {
    const service = this.ensureService();
    const abs = this.toAbs(file);
    const offset = this.positionToOffset(abs, line, column);
    if (offset === null) return { references: [] };
    const refs = service.getReferencesAtPosition(abs, offset) ?? [];
    const references = refs.map((r) => {
      const pos = this.offsetToPosition(r.fileName, r.textSpan.start);
      return {
        file: this.toRel(r.fileName),
        line: pos.line,
        column: pos.column,
        isWriteAccess: r.isWriteAccess,
      };
    });
    return { references };
  }

  getHover(file: string, line: number, column: number): HoverResult | null {
    const service = this.ensureService();
    const abs = this.toAbs(file);
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
    const service = this.ensureService();
    const abs = this.toAbs(file);
    const syntactic = service.getSyntacticDiagnostics(abs);
    const semantic = service.getSemanticDiagnostics(abs);
    const all: DiagnosticResult[] = [];
    for (const d of [...syntactic, ...semantic]) {
      let fileRel = file;
      let line = 0;
      let column = 0;
      if (d.file && d.start !== undefined) {
        fileRel = this.toRel(d.file.fileName);
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
        file: fileRel,
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
    const service = this.ensureService();
    const abs = this.toAbs(file);
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
  const key = resolve(projectRoot);
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

// Ensure we re-import the join helper (used nowhere directly — kept here to
// satisfy lints that worry about unused imports after refactoring).
void join;
