import { isAbsolute, join } from 'node:path';
import { readFileSync, readdirSync, existsSync, lstatSync, statSync } from 'node:fs';
import { defineTool, type McpTool } from '../tool.js';
import { assignWorkspaceSlugs } from '@mcp/shared/utils/workspace-slug.js';
import {
  readFileSlice,
  extractSkeletonFromFile,
  extractSymbolBodyFromContent,
  findSymbolDeclLineFromContent,
  findEnclosingDeclLine,
} from '@mcp/services/services/code-reader.js';
import { treeSitterSymbols } from '@mcp/indexer/indexer/incremental.js';
import { normalizeFilePath, withProject, formatOutput } from './_helpers.js';

/**
 * Tree-sitter-driven skeleton fallback. Used when the symbol DB has no row
 * for the file (project never indexed, or freshly created file). Reads
 * directly from disk under the project root and returns a skeleton-shaped
 * payload that callers can render in either text or JSON form.
 *
 * Returns null when the file isn't on disk or tree-sitter can't parse it.
 */
async function diskSkeletonFallback(
  projectRoot: string,
  relPath: string,
): Promise<{
  symbols: Array<{ line: number; end_line?: number; kind: string; name: string; signature: string; parent: string | null }>;
  lineCount: number;
  bytes: number;
} | null> {
  const abs = join(projectRoot, relPath);
  if (!existsSync(abs)) return null;
  let content: string;
  try {
    content = readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
  let stat: { size: number };
  try { stat = statSync(abs); } catch { stat = { size: content.length }; }
  const lineCount = content.split('\n').length;
  const ts = await treeSitterSymbols(relPath, content);
  if (ts) {
    return {
      symbols: ts.symbols.map((s) => ({
        line: s.line,
        end_line: s.end_line,
        kind: s.kind,
        name: s.name,
        signature: s.signature,
        parent: s.parent,
      })),
      lineCount,
      bytes: stat.size,
    };
  }
  // Last-resort regex skeleton — covers languages without a tree-sitter grammar.
  const regex = extractSkeletonFromFile(abs);
  if (regex.length === 0) return null;
  return {
    symbols: regex.map((e) => ({
      line: e.line,
      end_line: undefined,
      kind: e.kind,
      name: e.name,
      signature: e.signature,
      parent: null,
    })),
    lineCount,
    bytes: stat.size,
  };
}

// `get_file_structure` was retired from the MCP surface (tool audit 2026-07,
// docs/audit/TOOL_AUDIT.md): 0 calls in telemetry — get_file_skeleton won as
// the outline tool, and the extra per-symbol metadata (comments, tags,
// deps/dependents inline) is available via read_file / get_dependencies.
const get_file_skeleton = defineTool({
  name: 'get_file_skeleton',
  description: 'Compact outline of a file: header + symbol list (line, kind, name, signature). Symbol count is capped by max_symbols (default 100). Pass format="json" for a structured response.\n' +
    'file_path may also be a DIRECTORY — returns the exported symbols of the indexed files under it (grouped per file), which is the cheapest way to map an unfamiliar module.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      file_path: { type: 'string' },
      kind: { type: 'string', description: 'Filter by symbol kind' },
      filter: { type: 'string', description: 'Regex on symbol name' },
      max_symbols: { type: 'number', description: 'Max symbols listed (default 100)' },
      format: { type: 'string', enum: ['text', 'json'] },
      force_reread: {
        type: 'boolean',
        description:
          'Bypass the duplicate-result marker. Set true if you believe the file changed since a previous call. Default false.',
      },
    },
    required: ['project_name', 'file_path'],
  },
  handler: withProject(async (args, { db }, project) => {
    const filePath = normalizeFilePath(args.file_path as string, project.root_path);
    const file = db.getFile(project.id, filePath);
    if (!file) {
      // Directory skeleton: aggregate EXPORTED symbols of the indexed files
      // under the path — the cheapest "map this module" call for agents.
      const dirPrefix = filePath.replace(/\/+$/, '') + '/';
      const dirFiles = db.listFiles(project.id).filter((f) => f.path.startsWith(dirPrefix));
      if (dirFiles.length > 0) {
        const maxSymbols = (args.max_symbols as number) ?? 100;
        const kindFilterD = args.kind as string | undefined;
        const nameFilterD = args.filter as string | undefined;
        let nameRe: RegExp | null = null;
        if (nameFilterD) { try { nameRe = new RegExp(nameFilterD); } catch { /* ignore */ } }
        const groups: Array<{ path: string; syms: ReturnType<typeof db.getSymbolsByFile> }> = [];
        let total = 0;
        for (const f of dirFiles.slice(0, 40)) {
          let syms = db.getSymbolsByFile(project.id, f.path).filter((s) => s.exported);
          if (kindFilterD) syms = syms.filter((s) => s.kind === kindFilterD);
          if (nameRe) syms = syms.filter((s) => nameRe.test(s.name));
          if (syms.length === 0) continue;
          groups.push({ path: f.path, syms });
          total += syms.length;
        }
        let shown = 0;
        const truncatedDir = total > maxSymbols || dirFiles.length > 40;
        if (args.format === 'json') {
          return JSON.stringify({
            directory: filePath, files_in_dir: dirFiles.length, total_symbols: total, truncated: truncatedDir,
            files: groups.flatMap((g) => {
              if (shown >= maxSymbols) return [];
              const take = g.syms.slice(0, maxSymbols - shown); shown += take.length;
              return [{ path: g.path, symbols: take.map((s) => ({ line: s.line, kind: s.kind, name: s.name, signature: s.signature })) }];
            }),
          });
        }
        const lines: string[] = [`DIR ${filePath} | ${dirFiles.length} files | exported symbols${truncatedDir ? ` [showing ${Math.min(total, maxSymbols)}/${total}]` : ''}`, ''];
        for (const g of groups) {
          if (shown >= maxSymbols) break;
          lines.push(g.path);
          for (const s of g.syms) {
            if (shown >= maxSymbols) break;
            lines.push(`${String(s.line ?? '?').padStart(5)} ${s.kind} ${s.parent ? `${s.parent}.` : ''}${s.name}${s.signature && s.signature !== s.name ? ` ${s.signature}` : ''}`);
            shown++;
          }
        }
        return lines.join('\n');
      }
      // Tree-sitter fallback: parse the file off disk so the agent gets a
      // useful skeleton even when the project has never been indexed (or
      // the file is brand-new and not in `files` yet).
      const fallback = await diskSkeletonFallback(project.root_path, filePath);
      if (!fallback) {
        throw new Error(
          `File "${filePath}" not found in index nor on disk (or its language is unsupported). ` +
          `Use list_directory or search to find the correct path. Do not retry with the same file_path.`,
        );
      }
      const kindFilterX = args.kind as string | undefined;
      const nameFilterX = args.filter as string | undefined;
      const maxX = (args.max_symbols as number) ?? 100;
      const asJsonX = args.format === 'json';
      let syms = fallback.symbols;
      if (kindFilterX) syms = syms.filter((s) => s.kind === kindFilterX);
      if (nameFilterX) {
        try { const re = new RegExp(nameFilterX); syms = syms.filter((s) => re.test(s.name)); } catch { /* ignore */ }
      }
      const totalX = syms.length;
      const truncatedX = totalX > maxX;
      const shownX = truncatedX ? syms.slice(0, maxX) : syms;
      const extX = filePath.split('.').pop() ?? '';
      if (asJsonX) {
        return JSON.stringify({
          file: { path: filePath, ext: extX, line_count: fallback.lineCount, size_bytes: fallback.bytes },
          total_symbols: totalX,
          shown_symbols: shownX.length,
          truncated: truncatedX,
          source: 'tree-sitter-fallback',
          symbols: shownX.map((s) => ({ line: s.line, kind: s.kind, parent: s.parent, name: s.name, signature: s.signature })),
        });
      }
      const headerX = `${filePath} | ${extX} | ${fallback.lineCount}L | tree-sitter fallback (project not indexed)`;
      const truncNoteX = truncatedX ? `[truncated: showing ${shownX.length}/${totalX} symbols]` : '';
      const symLinesX = shownX.map((s) => {
        const parent = s.parent ? `${s.parent}.` : '';
        return `${String(s.line ?? '?').padStart(5)} ${s.kind} ${parent}${s.name}${s.signature && s.signature !== s.name ? ` ${s.signature}` : ''}`;
      });
      return [headerX, truncNoteX, '', ...symLinesX].filter(Boolean).join('\n');
    }
    let symbols = db.getSymbolsByFile(project.id, filePath);
    const kindFilter = args.kind as string | undefined;
    const nameFilter = args.filter as string | undefined;
    const maxSymbols = (args.max_symbols as number) ?? 100;
    const asJson = args.format === 'json';
    if (kindFilter) symbols = symbols.filter(s => s.kind === kindFilter);
    if (nameFilter) {
      try { const re = new RegExp(nameFilter); symbols = symbols.filter(s => re.test(s.name)); } catch { /* ignore */ }
    }
    const ext = filePath.split('.').pop() ?? '';
    const totalSymbols = symbols.length;
    const truncated = totalSymbols > maxSymbols;
    const shownSymbols = truncated ? symbols.slice(0, maxSymbols) : symbols;

    interface ExtraEntry { line: number | null; kind: string; name: string; signature: string; from_fallback: true }
    const extras: ExtraEntry[] = [];
    if (symbols.length < 3 && file.line_count > 80 && !kindFilter && !nameFilter) {
      try {
        const extracted = extractSkeletonFromFile(join(project.root_path, filePath));
        const known = new Set(symbols.map(s => `${s.line}:${s.name}`));
        for (const e of extracted) {
          if (known.has(`${e.line}:${e.name}`)) continue;
          if (extras.length + shownSymbols.length >= maxSymbols) break;
          extras.push({ line: e.line, kind: e.kind, name: e.name, signature: e.signature.slice(0, 100), from_fallback: true });
        }
      } catch { /* ignore */ }
    }

    if (asJson) {
      return JSON.stringify({
        file: {
          path: filePath,
          ext,
          language: file.language,
          line_count: file.line_count,
          size_bytes: file.size,
          content_hash: file.content_hash,
        },
        total_symbols: totalSymbols,
        shown_symbols: shownSymbols.length + extras.length,
        truncated,
        symbols: [
          ...shownSymbols.map(s => ({
            line: s.line,
            kind: s.kind,
            parent: s.parent,
            name: s.name,
            signature: s.signature,
            stable_id: s.stable_id,
          })),
          ...extras,
        ],
      });
    }

    const header = `${filePath} | ${file.language || ext} | ${file.line_count}L | ${file.size} bytes`;
    const truncateNote = truncated
      ? `[truncated: showing ${shownSymbols.length}/${totalSymbols} symbols — use max_symbols or kind/filter to refine]`
      : '';
    const symLines = shownSymbols.map(s => {
      const parent = s.parent ? `${s.parent}.` : '';
      const sig = s.signature || (s.parameters ? `(${s.parameters})` : '');
      return `${String(s.line ?? '?').padStart(5)} ${s.kind} ${parent}${s.name}${sig && sig !== s.name ? ` ${sig}` : ''}`;
    });
    let fallbackNote = '';
    if (extras.length > 0) {
      fallbackNote = `\n[regex fallback -- DB had ${symbols.length} symbols]`;
      for (const e of extras) {
        symLines.push(`${String(e.line ?? '?').padStart(5)} ${e.kind} ${e.name} ${e.signature}`);
      }
    }
    return [header, truncateNote, fallbackNote, '', ...symLines].filter(Boolean).join('\n');
  }),
});

const read_file = defineTool({
  name: 'read_file',
  description:
    'Read a file slice with smart defaults. Auto-returns the whole file when it has ≤800 lines (no pagination needed for most source files).\n' +
    '\n' +
    'Decision tree (follow this BEFORE calling read_file):\n' +
    '1. Don\'t know total_lines? → call get_file_skeleton FIRST. It returns file size + outline in <100 tokens.\n' +
    '2. File ≤800 lines → read_file returns the whole file in one call (auto-full).\n' +
    '3. File >800 + you know the symbol name → pass `symbol: "<name>"` (or call get_symbol_body).\n' +
    '4. File >800 + you have a stack frame / grep hit → pass `around_line: <n>` to get the enclosing function.\n' +
    '5. File >800 + you know a string → pass `search_term:` to center the window on the first match.\n' +
    '6. File >800 + you need everything → pass `force: true` (returns the full file in one call).\n' +
    '\n' +
    'NEVER: paginate more than twice on the same file. After 2 calls without finding what you need, switch tactics (skeleton, symbol, grep, force). The doom-loop guard aborts repetitive turns.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      file_path: { type: 'string' },
      symbol: {
        type: 'string',
        description: 'Return only the body of this symbol (function/class/etc.). Wins over start_line/end_line/search_term when set.',
      },
      around_line: {
        type: 'number',
        description: 'Return the symbol body that contains this 1-indexed line. Useful when you have a stack frame or grep hit.',
      },
      search_term: { type: 'string', description: 'Center the read window around the first match of this regex (case-insensitive).' },
      start_line: { type: 'number' },
      end_line: { type: 'number' },
      max_lines: { type: 'number', description: 'Default 400.' },
      force: { type: 'boolean', description: 'Return the full file in one call. Use for files >800 lines when you need everything.' },
      force_reread: {
        type: 'boolean',
        description:
          'Bypass the duplicate-result marker. Set true ONLY when you believe the file changed since a previous read. Orthogonal to `force` — `force` controls truncation (size), `force_reread` controls cache (skip the dup-content marker). Default false.',
      },
    },
    required: ['project_name', 'file_path'],
  },
  handler: withProject((args, { db }, project) => {
    const filePath = normalizeFilePath(args.file_path as string, project.root_path);
    const file = db.getFile(project.id, filePath);
    const abs = join(project.root_path, filePath);
    const AUTO_FULL_THRESHOLD = 800;

    // Symbol-targeted modes (shared by both DB-indexed and disk-fallback paths).
    // Loads full content once and extracts only the requested symbol body.
    const symbolArg = typeof args.symbol === 'string' ? (args.symbol as string).trim() : '';
    const aroundLine = typeof args.around_line === 'number' ? (args.around_line as number) : null;
    if (symbolArg || aroundLine !== null) {
      let content: string;
      try { content = readFileSync(abs, 'utf-8'); } catch (e) {
        throw new Error(
          `File "${filePath}" not found on disk: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const totalLines = content.split('\n').length;
      let anchor: number | null = null;
      if (symbolArg) {
        anchor = findSymbolDeclLineFromContent(content, symbolArg);
        if (anchor === null) {
          throw new Error(
            `Symbol '${symbolArg}' not found in ${filePath}. Fall back to a line range, search_term, or grep first.`,
          );
        }
      } else if (aroundLine !== null) {
        anchor = findEnclosingDeclLine(content, aroundLine);
      }
      if (anchor !== null) {
        const body = extractSymbolBodyFromContent(filePath, content, anchor);
        const header = `${filePath} — symbol body (lines ${body.start_line}-${body.end_line} of ${totalLines})\n`;
        return header + body.body;
      }
    }

    // Disk fallback: file exists on disk but isn't in the index. Read it
    // directly so the agent gets the content in non-indexed projects and
    // for files created in this session. Surface a tag so the model knows
    // it's seeing fallback output.
    if (!file) {
      let stat: { isFile(): boolean; size: number };
      try { stat = statSync(abs); } catch {
        throw new Error(
          `File "${filePath}" not found in index nor on disk. Use list_directory or search to find the correct path. Do not retry with the same file_path.`,
        );
      }
      if (!stat.isFile()) {
        throw new Error(
          `Path "${filePath}" exists but is a directory. Use list_directory on it instead.`,
        );
      }
      const startLineArg = args.start_line as number | undefined;
      const endLineArg = args.end_line as number | undefined;
      let startLine = startLineArg ?? 1;
      const maxLines = (args.max_lines as number | undefined) ?? 400;
      const autoFull = process.env.CODER_READ_FILE_AUTOFULL_DISABLE !== '1';
      try {
        const content = readFileSync(abs, 'utf-8');
        const lines = content.split('\n');
        const total = lines.length;
        const force = args.force === true;
        const isAutoFull = autoFull && !args.search_term && startLineArg === undefined && endLineArg === undefined && total <= AUTO_FULL_THRESHOLD;

        let headerNote = '';
        if (typeof args.search_term === 'string' && args.search_term.length > 0 && !isAutoFull) {
          const term = args.search_term as string;
          try {
            const re = new RegExp(term, 'i');
            const idx = lines.findIndex((l) => re.test(l));
            if (idx === -1) return `[Search term "${term}" not found in ${filePath}. Use grep_code to search across files.]`;
            startLine = Math.max(1, idx + 1 - Math.floor(maxLines / 2));
            headerNote = `[Auto-scrolled to line ${idx + 1} matching "${term}"]\n`;
          } catch (e) {
            return `Invalid search_term regex: ${(e as Error).message}`;
          }
        }

        const endLine = endLineArg ?? ((force || isAutoFull) ? total : Math.min(total, startLine + maxLines - 1));
        const slice = lines.slice(startLine - 1, endLine);
        const numbered = slice.map((l, i) => `${startLine + i}\t${l}`).join('\n');
        const ext = filePath.split('.').pop() ?? '';
        const tag = isAutoFull
          ? ' [auto-full: file ≤800 lines]'
          : endLine < total && total > AUTO_FULL_THRESHOLD
            ? ' [auto-full off — file > 800 lines, pass force=true to read all]'
            : '';
        const header = `${filePath} | ${total} lines | ${ext} | [disk fallback — file not indexed]\n[lines ${startLine}-${endLine}]${tag}\n`;
        const remaining = total - endLine;
        const footer = remaining > 0 ? `\n... [${remaining} more lines — pass force=true, symbol, around_line, or search_term]` : '';
        return header + headerNote + numbered + footer;
      } catch (e) {
        throw new Error(`Failed to read ${filePath} from disk: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const startLine = args.start_line as number | undefined;
    const endLine = args.end_line as number | undefined;
    const maxLines = (args.max_lines as number) ?? 400;
    const force = args.force === true;
    const autoFull = process.env.CODER_READ_FILE_AUTOFULL_DISABLE !== '1';
    let start = startLine ?? 1;
    let headerNote = '';

    // Auto-full: when the file fits in AUTO_FULL_THRESHOLD lines AND the
    // caller didn't explicitly opt out via env, return the whole thing in a
    // single response. This is the single biggest lever against pagination
    // loops — most source files are <800 lines.
    const isAutoFull =
      autoFull &&
      !args.search_term &&
      startLine === undefined &&
      endLine === undefined &&
      file.line_count <= AUTO_FULL_THRESHOLD;

    if (typeof args.search_term === 'string' && args.search_term.length > 0 && !isAutoFull) {
      const term = args.search_term as string;
      try {
        const content = readFileSync(abs, 'utf-8');
        const lines = content.split('\n');
        const re = new RegExp(term, 'i');
        const idx = lines.findIndex((l) => re.test(l));
        if (idx === -1) {
          return `[Search term "${term}" not found in ${filePath}. Use grep_code to search across files.]`;
        }
        start = Math.max(1, idx + 1 - Math.floor(maxLines / 2));
        headerNote = `[Auto-scrolled to line ${idx + 1} matching "${term}"]\n`;
      } catch (e) {
        return `Failed to read file for search_term: ${(e as Error).message}`;
      }
    }

    const defaultEnd = (force || isAutoFull)
      ? file.line_count
      : Math.min(file.line_count, start + maxLines - 1);
    const end = endLine ?? defaultEnd;
    try {
      const slice = readFileSlice(abs, start, end);
      const numbered = slice.lines.map((l, i) => `${start + i}\t${l}`).join('\n');
      const remaining = file.line_count - end;
      const ext = filePath.split('.').pop() ?? '';
      const tag = isAutoFull
        ? ' [auto-full: file ≤800 lines]'
        : remaining > 0 && file.line_count > AUTO_FULL_THRESHOLD
          ? ' [auto-full off — file > 800 lines, pass force=true to read all]'
          : '';
      const richHeader = `${filePath} | ${file.line_count} lines | ${ext}\n[lines ${start}-${end}]${tag}\n`;
      const footer = remaining > 0
        ? `\n... [${remaining} more lines — pass force=true, symbol, around_line, or search_term]`
        : '';
      return richHeader + headerNote + numbered + footer;
    } catch (e) {
      return `Failed: ${(e as Error).message}`;
    }
  }),
});

const list_directory = defineTool({
  name: 'list_directory',
  description: 'List files under a path prefix. Reads from the index when populated; falls back to a bounded disk scan when the index has nothing for the path (project not indexed, or directory created in this session).',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, path: { type: 'string' }, depth: { type: 'number' } },
    required: ['project_name'],
  },
  handler: withProject((args, { db }, project) => {
    const prefix = (args.path as string | undefined) ?? '';
    const depth = (args.depth as number) ?? 2;
    const files = db.listFiles(project.id);
    const baseDepth = prefix ? prefix.split('/').filter(Boolean).length : 0;
    const filtered = files.filter(f => !prefix || f.path.startsWith(prefix));
    const out: string[] = [];
    for (const f of filtered) {
      const parts = f.path.split('/');
      if (parts.length - baseDepth > depth + 1) continue;
      out.push(`${f.path} (${f.line_count}L)`);
    }
    if (out.length > 0) {
      return out.slice(0, 200).join('\n');
    }
    // Disk fallback: index is empty for this prefix. Walk the directory
    // directly so the agent gets useful results in non-indexed projects
    // and on freshly created paths.
    const topLevelLinks = project.is_synthetic
      ? new Set(assignWorkspaceSlugs(db.listUnionProjectIds(project.id)).map((p) => p.slug))
      : undefined;
    const diskEntries = listDirectoryFromDisk(project.root_path, prefix, depth, topLevelLinks);
    if (diskEntries.length === 0) {
      return 'Empty.';
    }
    return `[disk fallback — index has no entries for this path]\n` + diskEntries.slice(0, 200).join('\n');
  }),
});

/**
 * Bounded recursive directory listing for the disk fallback. Skips the same
 * standard ignore dirs the project scanner uses so we don't dump
 * `node_modules` into the result. Lines mirror the indexed format
 * (`<rel-path> (<size>B)`) so the LLM doesn't need to special-case the
 * fallback output.
 */
export function listDirectoryFromDisk(
  rootPath: string,
  prefix: string,
  depth: number,
  topLevelLinks?: ReadonlySet<string>,
): string[] {
  const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.mcp-indexer', '.cache', '.turbo', 'coverage']);
  const normalizedPrefix = prefix.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const prefixParts = normalizedPrefix.split('/').filter((part) => part && part !== '.');
  if (isAbsolute(prefix) || prefixParts.includes('..')) return [];
  if (topLevelLinks && prefixParts.length > 0) {
    if (!topLevelLinks.has(prefixParts[0])) return [];
    // The first segment is the DB-authorized workspace junction. Reject a
    // replaced first link and every nested link in a direct-prefix request so
    // callers cannot skip the guarded root walk.
    let cursor = join(rootPath, prefixParts[0]);
    try {
      if (!lstatSync(cursor).isSymbolicLink()) return [];
      for (const part of prefixParts.slice(1)) {
        cursor = join(cursor, part);
        if (lstatSync(cursor).isSymbolicLink()) return [];
      }
    } catch { return []; }
  }
  const startAbs = prefixParts.length > 0 ? join(rootPath, ...prefixParts) : rootPath;
  let stat: { isDirectory(): boolean };
  try { stat = statSync(startAbs); } catch { return []; }
  if (!stat.isDirectory()) {
    // The prefix points at a file: report just that one.
    try {
      const fileStat = statSync(startAbs);
      const norm = prefix.replace(/\\/g, '/');
      return [`${norm} (${fileStat.size}B)`];
    } catch { return []; }
  }
  const out: string[] = [];
  const walk = (absDir: string, relDir: string, level: number): void => {
    if (level > depth) return;
    let entries: {
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }[] = [];
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= 500) return;
      if (IGNORE.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const childAbs = join(absDir, entry.name);
      const atSyntheticRoot = level === 0 && !relDir && !!topLevelLinks;
      const isAuthorizedTopLevelLink =
        atSyntheticRoot && topLevelLinks.has(entry.name) && entry.isSymbolicLink();
      if (atSyntheticRoot && !isAuthorizedTopLevelLink) continue;
      if (entry.isDirectory() || isAuthorizedTopLevelLink) {
        out.push(`${childRel}/`);
        walk(childAbs, childRel, level + 1);
      } else if (entry.isFile()) {
        let size = 0;
        try { size = statSync(childAbs).size; } catch { /* ignore */ }
        out.push(`${childRel} (${size}B)`);
      }
    }
  };
  walk(startAbs, normalizedPrefix, 0);
  return out;
}

const get_recently_modified_files = defineTool({
  name: 'get_recently_modified_files',
  description:
    'List the most recently modified files in the index, newest first (timestamp, path, line count).\n' +
    'Default limit 20. Useful to see what changed lately or where current work is happening.',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, limit: { type: 'number' } },
    required: ['project_name'],
  },
  handler: withProject((args, { db }, project) => {
    const limit = (args.limit as number) ?? 20;
    const files = db.listFiles(project.id)
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      .slice(0, limit);
    return files.map(f => `${f.updated_at} ${f.path} (${f.line_count}L)`).join('\n') || 'No files.';
  }),
});

const get_dependencies = defineTool({
  name: 'get_dependencies',
  description:
    'List everything a file imports, with resolved in-project target paths where known.\n' +
    "DON'T: use to find who imports THIS file — that's get_dependents.",
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, file_path: { type: 'string' } },
    required: ['project_name', 'file_path'],
  },
  handler: withProject((args, { db }, project) => {
    const filePath = normalizeFilePath(args.file_path as string, project.root_path);
    const file = db.getFile(project.id, filePath);
    if (!file) throw new Error(`File "${filePath}" not found in index. Use list_directory or search to find the correct path. Do not retry with the same file_path.`);
    const deps = db.getDependencies(file.id, project.id);
    return deps.map(d => `${d.dep_type} ${d.import_path}${d.target_file_path ? ` → ${d.target_file_path}` : ''}`).join('\n') || 'No dependencies found.';
  }),
});

const get_dependents = defineTool({
  name: 'get_dependents',
  description:
    'List every file that imports a given file (reverse dependencies) — the blast radius of editing it.\n' +
    "DON'T: use to see what this file itself imports — that's get_dependencies.",
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, file_path: { type: 'string' } },
    required: ['project_name', 'file_path'],
  },
  handler: withProject((args, { db }, project) => {
    const filePath = normalizeFilePath(args.file_path as string, project.root_path);
    const file = db.getFile(project.id, filePath);
    if (!file) throw new Error(`File "${filePath}" not found in index. Use list_directory or search to find the correct path. Do not retry with the same file_path.`);
    const deps = db.getDependents(project.id, file.id);
    return deps.map(d => `${d.source_file_path} (${d.import_path})`).join('\n') || 'No dependents found.';
  }),
});

export const fileTools: McpTool[] = [
  get_file_skeleton,
  read_file,
  list_directory,
  get_recently_modified_files,
  get_dependencies,
  get_dependents,
];
