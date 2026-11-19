import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { CASCADING_REPLACERS, type ReplacerHit } from '@mcp/code-agent/tools/edit-replacers.js';
import {
  resolveAuthorizedPath,
  resolveWorkspacePath,
  pathFor,
  type WorkspacePathResult,
} from '@mcp/code-agent/tools/paths.js';
import {
  defaultLocalFilesystemPort,
  type IFilesystemPort,
} from '@mcp/code-agent/ports/filesystem-port.js';
import { emitRecentFileTouched } from '@mcp/code-agent/tools/global-recent-files.js';
import { truncationMarker } from '@mcp/code-agent/tools/truncation-marker.js';
import { managePathTool } from '@mcp/code-agent/tools/manage-path.js';
import { describeClosestRegion } from './apply-patch-match.js';
import { recoverOmittedTypeProperty } from './edit-typescript-property.js';
import { missingFileHint } from './missing-file-hint.js';

/**
 * Resolve the filesystem port for a tool invocation. Falls back to the
 * process-wide local adapter when no port is wired (tests, legacy code
 * paths). Behavior is byte-for-byte identical to calling node:fs directly.
 */
function fsPort(ctx: ToolContext): IFilesystemPort {
  return ctx.ports?.fs ?? defaultLocalFilesystemPort();
}
import {
  WRITE_FILE_DESC,
  CREATE_FILE_DESC,
  EDIT_FILE_DESC,
  MULTI_EDIT_DESC,
  READ_FILE_NATIVE_DESC,
  LIST_DIRECTORY_NATIVE_DESC,
  maybeTerse,
} from '@mcp/code-agent/tools/descriptions.js';
import {
  extractSymbolBodyFromContent,
  findSymbolDeclLineFromContent,
} from '@mcp/services/services/code-reader.js';

/** The project root a native fs call resolved to (primary or a linked root). */
interface RootSel {
  root: string;
  projectName: string;
  projectId: number | undefined;
}

/**
 * Resolve a native filesystem path to one real project root.
 *
 * Public calls select linked projects with `<project-slug>/...` in `path`.
 * The hidden `project`/`project_name` branch remains only for old telemetry and
 * nested callers; it is deliberately absent from every native tool schema.
 */
function resolveFsTarget(
  args: Record<string, unknown>,
  ctx: ToolContext,
  inputPath: string,
  intent: 'read' | 'write',
): { resolved: Extract<WorkspacePathResult, { ok: true }> } | { error: ToolResult } {
  const requested =
    typeof args.project === 'string'
      ? args.project.trim()
      : typeof args.project_name === 'string'
        ? args.project_name.trim()
        : '';
  if (!requested) {
    const resolved = resolveWorkspacePath(inputPath, ctx, intent);
    return resolved.ok ? { resolved } : { error: err(resolved.reason) };
  }

  const project = ctx.globalWorkspace?.projects.find(
    (candidate) => candidate.slug === requested || candidate.name === requested,
  );
  const secondary = ctx.roots?.find((candidate) =>
    candidate.slug === requested || candidate.name === requested);
  const selected: RootSel | undefined = project
    ? {
        root: project.rootPath,
        projectName: project.name,
        projectId: project.projectId,
      }
    : requested === ctx.projectName
      ? { root: ctx.cwd, projectName: ctx.projectName, projectId: ctx.projectId }
      : secondary
        ? {
            root: secondary.rootPath,
            projectName: secondary.name,
            projectId: secondary.projectId,
          }
        : undefined;
  if (selected) {
    const resolved = resolveAuthorizedPath(
      inputPath,
      selected.root,
      selected.root === ctx.cwd ? ctx.externalRoots : undefined,
      intent,
    );
    if (!resolved.ok) return { error: err(resolved.reason) };
    return {
      resolved: {
        ...resolved,
        projectId: resolved.external ? undefined : selected.projectId,
        projectName: selected.projectName,
      },
    };
  }
  const known =
    ctx.globalWorkspace && ctx.globalWorkspace.projects.length > 0
      ? ` Linked projects in this session: ${ctx.globalWorkspace.projects.map((entry) => entry.slug).join(', ')}.`
      : '';
  return {
    error: err(
        `This native tool operates on the current project ('${ctx.projectName}'). ` +
        `'${requested}' is neither the primary project nor a linked root, so it would silently ` +
        `resolve against the wrong root.${known} ` +
        `Use a '<project-slug>/' path prefix or that project's prefixed MCP tools ` +
        `(e.g. mcp__<project>__read_file).`,
    ),
  };
}

/**
 * The overlay to mark a touched file in. For a write to a linked secondary root
 * (global session) it's that root's overlay so the project's MCP reads serve
 * fresh content; otherwise the PRIMARY overlay. Identical to `ctx.overlay` for
 * normal sessions (no `overlayByRoot`).
 */
function overlayFor(ctx: ToolContext, projectId: number | undefined): ToolContext['overlay'] {
  if (projectId != null && ctx.overlayByRoot?.has(projectId)) return ctx.overlayByRoot.get(projectId);
  return ctx.overlay;
}

function markOverlay(ctx: ToolContext, projectId: number | undefined, path: string, external: boolean): void {
  if (!external) overlayFor(ctx, projectId)?.mark(path);
}

const writeFile: CoderTool = {
  name: 'write_file',
  effectBoundary: 'filesystem',
  description: maybeTerse(WRITE_FILE_DESC),
  source: 'native',
  // Phase 2 hardening: explicit metadata co-located with the tool. The
  // policy module (core/policy.ts) reads these to gate the invocation —
  // here, plan-mode blocks until `submit_plan` is approved unless the
  // current task scope unlocks paths. `parallelSafe: false` because two
  // concurrent writes to the same file would race.
  mutates: true,
  parallelSafe: false,
  riskLevel: 'write',
  scopeAware: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative path; use "<project-slug>/..." in a global session. Absolute paths require an authorized writable external root.' },
      content: { type: 'string', description: 'Full new content of the file' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const path = String(args.path ?? '');
    const content = String(args.content ?? '');
    const target = resolveFsTarget(args, ctx, path, 'write');
    if ('error' in target) return target.error;
    const { resolved } = target;
    const abs = resolved.abs;
    const fs = fsPort(ctx);
    await fs.mkdir(pathFor(resolved.rootPath).dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    markOverlay(ctx, resolved.projectId, resolved.relativePath, resolved.external);
    emitRecentFileTouched({ absolutePath: abs, kind: 'edit' });
    const lines = content.split('\n').length;
    return ok(`Wrote ${path} (${lines} lines, ${content.length} bytes)`);
  },
};

const createFile: CoderTool = {
  name: 'create_file',
  effectBoundary: 'filesystem',
  description: maybeTerse(CREATE_FILE_DESC),
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative path; use "<project-slug>/..." in a global session. Absolute paths require an authorized writable external root.' },
      content: { type: 'string', description: 'Initial content' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const path = String(args.path ?? '');
    const content = String(args.content ?? '');
    const target = resolveFsTarget(args, ctx, path, 'write');
    if ('error' in target) return target.error;
    const { resolved } = target;
    const abs = resolved.abs;
    const fs = fsPort(ctx);
    ctx.signal?.throwIfAborted();
    if (!fs.createFile) return err('Filesystem adapter does not support exclusive file creation.');
    await fs.mkdir(pathFor(resolved.rootPath).dirname(abs), { recursive: true });
    ctx.signal?.throwIfAborted();
    try { await fs.createFile(abs, content); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return err(`File ${path} already exists. Use write_file or edit_file to modify it.`);
      throw error;
    }
    markOverlay(ctx, resolved.projectId, resolved.relativePath, resolved.external);
    emitRecentFileTouched({ absolutePath: abs, kind: 'edit' });
    return ok(`Created ${path} (${Buffer.byteLength(content, 'utf8')} bytes)`);
  },
};

/**
 * Progressive fuzzy matcher for edit_file.
 *
 * Tries increasingly tolerant strategies until one finds a unique (or
 * replace_all-compatible) match:
 *   1. Exact match
 *   2. Normalize line endings (CRLF → LF on both sides)
 *   3. Trim trailing whitespace on each line of both sides
 *   4. Collapse runs of whitespace within each line (preserves indentation intent)
 *
 * Returns an `applied` boolean and the resulting full content, plus a
 * `strategy` label for the success message. When nothing matches, returns
 * diagnostic info with fuzzy hints.
 */
interface EditResult {
  applied: boolean;
  content?: string;
  occurrences: number;
  strategy: string;
}

function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function trimLines(s: string): string {
  return s.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');
}

function collapseWhitespace(s: string): string {
  return s.split('\n').map((l) => {
    const leading = l.match(/^[ \t]*/)?.[0] ?? '';
    const rest = l.slice(leading.length).replace(/[ \t]+/g, ' ');
    return leading + rest;
  }).join('\n');
}

/** Normalize typographic (curly/smart) quotes to straight ASCII quotes. */
function normalizeQuotes(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")  // curly single → straight
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"');  // curly double → straight
}

/** Full Unicode + quote normalization (NFC + curly quotes). */
function normalizeUnicode(s: string): string {
  return normalizeQuotes(s).normalize('NFC');
}

/**
 * Try to apply an edit using `oldStr`, `newStr`. If `norm` is provided,
 * both the haystack and the needle are passed through it before matching,
 * and then the replacement is applied to the matching representation.
 */
function applyEditWithTransform(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
  transform: (s: string) => string,
  strategyLabel: string
): EditResult {
  const tContent = transform(content);
  const tOld = transform(oldStr);
  if (!tOld) return { applied: false, occurrences: 0, strategy: strategyLabel };

  const occurrences = tContent.split(tOld).length - 1;
  if (occurrences === 0) return { applied: false, occurrences: 0, strategy: strategyLabel };
  if (occurrences > 1 && !replaceAll) {
    return { applied: false, occurrences, strategy: strategyLabel };
  }

  // When the transform is identity (exact match), we can do the replacement
  // directly on the original. Otherwise we reapply on the transformed string
  // — this changes whitespace in matched regions to the new_string's form,
  // which is usually what the caller wants anyway.
  if (strategyLabel === 'exact') {
    const updated = replaceAll
      ? content.split(oldStr).join(newStr)
      : content.replace(oldStr, () => newStr);
    return { applied: true, content: updated, occurrences, strategy: strategyLabel };
  }

  const updated = replaceAll
    ? tContent.split(tOld).join(newStr)
    : tContent.replace(tOld, () => newStr);
  return { applied: true, content: updated, occurrences, strategy: strategyLabel };
}

async function editSourceStillCurrent(fs: IFilesystemPort, path: string, expected: string): Promise<boolean> {
  const current = await fs.readFile(path).catch(() => null);
  return current === expected;
}

const editFile: CoderTool = {
  name: 'edit_file',
  effectBoundary: 'filesystem',
  description: maybeTerse(EDIT_FILE_DESC),
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative path; use "<project-slug>/..." in a global session. Absolute paths require an authorized writable external root.' },
      old_string: { type: 'string', description: 'Text to find. Should match file content closely — minor whitespace differences are tolerated automatically.' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const path = String(args.path ?? '');
    const oldStr = String(args.old_string ?? '');
    const newStr = String(args.new_string ?? '');
    const replaceAll = Boolean(args.replace_all);
    if (!path) return err('path is required and cannot be empty');
    if (!oldStr) return err('old_string cannot be empty');

    const target = resolveFsTarget(args, ctx, path, 'write');
    if ('error' in target) return target.error;
    const { resolved } = target;
    const abs = resolved.abs;
    const fs = fsPort(ctx);

    let content: string;
    try {
      content = await fs.readFile(abs);
    } catch {
      return err(`File ${path} not found`);
    }

    const result = await performSingleEdit(path, content, oldStr, newStr, replaceAll);
    if (!result.ok) return err(result.error);
    if (result.recovered && !(await editSourceStillCurrent(fs, abs, content))) {
      return err(`${path} changed while the edit was being prepared. Inspect the affected lines and retry.`);
    }
    await fs.writeFile(abs, result.content);
    markOverlay(ctx, resolved.projectId, resolved.relativePath, resolved.external);
    emitRecentFileTouched({ absolutePath: abs, kind: 'edit' });
    const suffix = result.strategy === 'exact' ? '' : ` [matched via: ${result.strategy}]`;
    return ok(`Edited ${path} (${result.occurrences} replacement${result.occurrences === 1 ? '' : 's'})${suffix}`);
  },
};

/**
 * Apply non-overlapping character-range hits to the content. Hits are assumed
 * to be sorted by start. When replaceAll is false, only the first hit is
 * applied (caller has already verified `hits.length === 1`).
 */
function applyHits(content: string, hits: ReplacerHit[], newStr: string, replaceAll: boolean): string {
  const targets = replaceAll ? hits.slice().sort((a, b) => a.start - b.start) : [hits[0]];
  let out = '';
  let cursor = 0;
  for (const hit of targets) {
    if (hit.start < cursor) continue; // skip overlapping (shouldn't happen with our replacers)
    out += content.slice(cursor, hit.start) + newStr;
    cursor = hit.end;
  }
  out += content.slice(cursor);
  return out;
}

const readFile: CoderTool = {
  name: 'read_file',
  description: maybeTerse(READ_FILE_NATIVE_DESC),
  source: 'native',
  outputPolicy: { mode: 'line_range', reducer: 'none', recovery: 'cursor' },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative path; use "<project-slug>/..." in a global session. Absolute paths require an authorized external root.' },
      start_line: { type: 'number', description: '1-indexed start line (optional)' },
      end_line: { type: 'number', description: '1-indexed inclusive end line (optional)' },
      symbol: {
        type: 'string',
        description:
          'Return only the body of this symbol (function/class/etc.). Locates the declaration via regex and extracts the brace/indent block. Wins over start_line/end_line when set.',
      },
      force: {
        type: 'boolean',
        description: 'Return the full file in one call regardless of size. Use for files >800 lines when you need everything.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const path = String(args.path ?? '');
    if (!path) return err('path is required and cannot be empty');
    const target = resolveFsTarget(args, ctx, path, 'read');
    if ('error' in target) return target.error;
    const { resolved } = target;
    const abs = resolved.abs;

    let content: string;
    try {
      content = await fsPort(ctx).readFile(abs);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return err(`Could not read ${path}: ${message}`);
      const parent = resolveAuthorizedPath(pathFor(resolved.rootPath).dirname(abs), resolved.rootPath, undefined, 'read');
      const hint = parent.ok ? await missingFileHint(fsPort(ctx), parent.abs, ctx.signal) : '';
      return err(`File ${path} not found: ${message}${hint}`);
    }
    // I2 — feed the recently-touched files cache so subsequent hybrid
    // searches can favor what the agent just looked at. Sub-ms, never
    // throws (sink wraps its own errors).
    emitRecentFileTouched({ absolutePath: abs, kind: 'view' });

    const lines = content.split('\n');
    const total = lines.length;

    // Symbol-targeted mode: locate the declaration, then extract the body block.
    const symbolArg = typeof args.symbol === 'string' ? args.symbol.trim() : '';
    if (symbolArg) {
      const anchor = findSymbolDeclLineFromContent(content, symbolArg);
      if (anchor === null) {
        return err(
          `Symbol '${symbolArg}' not found in ${path}. ` +
            `Fall back to a line range (start_line/end_line) or grep first.`,
        );
      }
      const body = extractSymbolBodyFromContent(path, content, anchor);
      const header = `${path} — symbol body (lines ${body.start_line}-${body.end_line} of ${total})\n`;
      return ok(header + body.body);
    }

    const startLineArg = typeof args.start_line === 'number' ? args.start_line : undefined;
    const endLineArg = typeof args.end_line === 'number' ? args.end_line : undefined;
    const force = args.force === true;
    // auto_full env-toggle preserved for tests; not exposed in schema.
    const autoFull = true;
    const AUTO_FULL_THRESHOLD = 800;
    // Default window when a large file is read without a range and without force.
    const DEFAULT_READ_LINES = 400;

    const startLine = startLineArg !== undefined ? Math.max(1, startLineArg) : 1;
    let endLine: number;

    const isAutoFull =
      autoFull &&
      startLineArg === undefined &&
      endLineArg === undefined &&
      total <= AUTO_FULL_THRESHOLD;

    if (endLineArg !== undefined) {
      endLine = Math.min(total, endLineArg);
    } else if (force || isAutoFull) {
      endLine = total;
    } else {
      endLine = Math.min(total, startLine + DEFAULT_READ_LINES - 1);
    }

    const slice = lines.slice(startLine - 1, endLine);
    const numbered = slice.map((line, i) => `${(startLine + i).toString().padStart(5)}\t${line}`).join('\n');
    const ext = path.split('.').pop() ?? '';
    const omittedBefore = startLine - 1;
    const remaining = total - endLine;
    const omitted = omittedBefore > 0 || remaining > 0;
    const tag = isAutoFull
      ? ' [auto-full: file ≤800 lines]'
      : remaining > 0 && total > AUTO_FULL_THRESHOLD
        ? ' [auto-full off — file > 800 lines, pass force=true to read all]'
        : '';
    const richHeader = `${path} | ${total} lines | ${ext}\n[lines ${startLine}-${endLine}]${tag}\n`;
    const omittedDetail = omittedBefore > 0
      ? remaining > 0
        ? `${omittedBefore} earlier and ${remaining} later lines omitted`
        : `${omittedBefore} earlier lines omitted`
      : `${remaining} more lines`;
    const footer = omitted
      ? `\n... ${truncationMarker(
          omittedDetail,
          omittedBefore > 0
            ? 'pass force=true, another start_line/end_line range, or symbol'
            : 'pass force=true, a start_line/end_line range, or symbol',
        )}`
      : '';
    return {
      content: richHeader + numbered + footer,
      ...(omitted
        ? {
            sourceTruncations: [{
              technique: 'read-file-line-window',
              inputSize: total,
              outputSize: slice.length,
              unit: 'lines' as const,
              recoverable: true,
            }],
          }
        : {}),
    };
  },
};

const listDirectory: CoderTool = {
  name: 'list_directory',
  description: maybeTerse(LIST_DIRECTORY_NATIVE_DESC),
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative path (default: project root); use "<project-slug>/..." in a global session. Absolute paths require an authorized external root.' },
      recursive: { type: 'boolean', description: 'Recurse into subdirectories (default false)' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const path = String(args.path ?? '.');
    const target = resolveFsTarget(args, ctx, path, 'read');
    if ('error' in target) return target.error;
    const { resolved } = target;
    const abs = resolved.abs;

    try {
      const fs = fsPort(ctx);
      const recursive = Boolean(args.recursive);
      const outputRoot = resolved.rootPath;
      const p = pathFor(outputRoot);
      const atGlobalRoot = !!ctx.globalWorkspace && (path === '.' || path === '');
      if (atGlobalRoot) {
        const lines = recursive
          ? (await Promise.all(ctx.globalWorkspace!.projects.map(async (project) => {
              const nested = await walkDir(fs, project.rootPath, project.rootPath);
              return [
                `d ${project.slug}`,
                ...nested.map((line) => line.replace(/^([df]) /, `$1 ${project.slug}/`)),
              ];
            }))).flat()
          : ctx.globalWorkspace!.projects.map((project) => `d ${project.slug}`);
        return ok(`${path} (${lines.length} entries)\n${lines.sort().join('\n')}`);
      }
      const entries = recursive
        ? await walkDir(fs, abs, outputRoot)
        : (await fs.readdir(abs, { withFileTypes: true })).map((e) => `${e.isDirectory() ? 'd' : 'f'} ${p.relative(outputRoot, p.resolve(abs, e.name)).replace(/\\/g, '/')}`);
      const lines = (resolved.workspacePrefix
        ? entries.map((line) => line.replace(/^([df]) /, `$1 ${resolved.workspacePrefix}/`))
        : entries).sort();
      return ok(`${path} (${lines.length} entries)\n${lines.join('\n')}`);
    } catch (e) {
      return err(`list_directory failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

async function walkDir(fs: IFilesystemPort, abs: string, projectRoot: string, depth = 0, max = 4): Promise<string[]> {
  if (depth > max) return [];
  const p = pathFor(projectRoot);
  const out: string[] = [];
  const entries = await fs.readdir(abs, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
    const full = p.resolve(abs, e.name);
    const rel = p.relative(projectRoot, full).replace(/\\/g, '/');
    if (e.isDirectory()) {
      out.push(`d ${rel}`);
      out.push(...(await walkDir(fs, full, projectRoot, depth + 1, max)));
    } else {
      out.push(`f ${rel}`);
    }
  }
  return out;
}

type SingleEditResult =
  | { ok: true; content: string; strategy: string; occurrences: number; recovered?: true }
  | { ok: false; error: string };

function ambiguousEdit(path: string, occurrences: number, strategy: string): SingleEditResult {
  return {
    ok: false,
    error: `old_string is not unique in ${path} (${occurrences} occurrences via ${strategy}). ` +
      'PREFERRED: add surrounding context to old_string so it anchors ONE specific occurrence. ' +
      `Use replace_all=true ONLY if you actually want to replace ALL ${occurrences} occurrences with verified old text.`,
  };
}

/** Shared matcher for a single edit and each step of an atomic batch. */
async function performSingleEdit(
  path: string,
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
): Promise<SingleEditResult> {
  if (!oldStr) return { ok: false, error: 'old_string cannot be empty' };

  const strategies: Array<{ label: string; transform: (s: string) => string }> = [
    { label: 'exact', transform: (s) => s },
    { label: 'line-endings normalized', transform: normalizeLineEndings },
    { label: 'trailing whitespace trimmed', transform: (s) => trimLines(normalizeLineEndings(s)) },
    { label: 'whitespace collapsed', transform: (s) => collapseWhitespace(trimLines(normalizeLineEndings(s))) },
    { label: 'quotes normalized', transform: (s) => normalizeQuotes(collapseWhitespace(trimLines(normalizeLineEndings(s)))) },
    { label: 'unicode normalized', transform: (s) => normalizeUnicode(collapseWhitespace(trimLines(normalizeLineEndings(s)))) },
  ];

  for (const { label, transform } of strategies) {
    const r = applyEditWithTransform(content, oldStr, newStr, replaceAll, transform, label);
    if (r.applied && r.content !== undefined) {
      return { ok: true, content: r.content, strategy: r.strategy, occurrences: r.occurrences };
    }
    if (r.occurrences > 1 && !replaceAll) return ambiguousEdit(path, r.occurrences, label);
  }

  // Looser character-range replacers.
  for (const { label, run } of CASCADING_REPLACERS) {
    const hits: ReplacerHit[] = run(content, oldStr);
    if (hits.length === 0) continue;
    if (hits.length > 1 && !replaceAll) return ambiguousEdit(path, hits.length, label);
    const updated = applyHits(content, hits, newStr, replaceAll);
    return { ok: true, content: updated, strategy: label, occurrences: hits.length };
  }

  if (!replaceAll) {
    const recovered = await recoverOmittedTypeProperty(path, content, oldStr, newStr);
    if (recovered) {
      const strategy = 'preserved TypeScript property type';
      if (recovered.content === undefined) return ambiguousEdit(path, recovered.occurrences, strategy);
      return { ok: true, content: recovered.content, strategy, occurrences: 1, recovered: true };
    }
  }

  const hint = describeClosestRegion(
    normalizeLineEndings(content).split('\n'), normalizeLineEndings(oldStr).split('\n'), 'old_string',
  ).trimEnd();
  return {
    ok: false,
    error: [
      `old_string not found in ${path}. Nothing was written.`,
      'Do not retry with the same old_string. Use the current text below to correct it. Read only the relevant lines if more context is needed.',
      hint,
    ].filter(Boolean).join('\n'),
  };
}

export const multiEdit: CoderTool = {
  name: 'multi_edit',
  effectBoundary: 'filesystem',
  description: maybeTerse(MULTI_EDIT_DESC),
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project-relative path; use "<project-slug>/..." in a global session. Absolute paths require an authorized writable external root.' },
      edits: {
        type: 'array',
        description: 'Ordered list of find/replace operations to apply sequentially. All must succeed, otherwise the file is left untouched (atomic).',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean', description: 'Default false. When true, every match of old_string is replaced.' },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['path', 'edits'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const path = String(args.path ?? '');
    const edits = Array.isArray(args.edits) ? args.edits : [];
    if (!path) return err('path is required and cannot be empty');
    if (edits.length === 0) return err('edits array cannot be empty — use write_file to replace the whole file or edit_file for a single change.');
    if (edits.length > 50) return err(`edits array has ${edits.length} items, max 50 per call. Split into multiple calls.`);

    const target = resolveFsTarget(args, ctx, path, 'write');
    if ('error' in target) return target.error;
    const { resolved } = target;
    const abs = resolved.abs;
    const fs = fsPort(ctx);

    let content: string;
    try {
      content = await fs.readFile(abs);
    } catch {
      return err(`File ${path} not found`);
    }

    // Full-validation pass: try every edit on the rolling buffer, but
    // do NOT abort on the first failure. The agent gets a complete
    // report so it can fix everything in a single re-submit instead of
    // discovering one error per round-trip (the pattern that caused
    // the write_stdin loop in session 798).
    //
    // Atomicity is preserved — disk is only written when EVERY edit
    // succeeds. When an edit fails the rolling buffer DOES NOT advance
    // (so subsequent edits see the same content as if the failing one
    // had been a no-op), which means:
    //   - Independent edits that target untouched regions get
    //     accurate verdicts (still succeed / still fail).
    //   - Edits that DEPEND on the failed edit's output will report
    //     "not found" or "still not unique" against the unchanged
    //     content — flagged with a hint so the agent recognises it.
    type EditOutcome =
      | { index: number; ok: true; strategy: string; occurrences: number }
      | { index: number; ok: false; error: string; dependsOnPrior: boolean };

    const outcomes: EditOutcome[] = [];
    let current = content;
    let recovered = false;
    let firstFailIdx = -1;
    for (let i = 0; i < edits.length; i++) {
      const raw = edits[i] as Record<string, unknown>;
      const oldStr = String(raw.old_string ?? '');
      const newStr = String(raw.new_string ?? '');
      const replaceAll = Boolean(raw.replace_all);
      const r = await performSingleEdit(path, current, oldStr, newStr, replaceAll);
      if (r.ok) {
        outcomes.push({ index: i, ok: true, strategy: r.strategy, occurrences: r.occurrences });
        // Rolling buffer only advances on success. Failures leave it
        // alone so the next edit's verdict mirrors what would happen
        // after the agent fixed the prior issue (best-effort).
        current = r.content;
        recovered ||= r.recovered === true;
        continue;
      }
      // Mark dependents: when an EARLIER edit failed, the rolling
      // buffer is "behind". This edit's verdict may be a false
      // positive — the agent should re-validate after fixing the
      // earlier failure. Flag explicitly.
      const dependsOnPrior = firstFailIdx >= 0;
      outcomes.push({ index: i, ok: false, error: r.error, dependsOnPrior });
      if (firstFailIdx < 0) firstFailIdx = i;
    }

    const failed = outcomes.filter((o): o is Extract<EditOutcome, { ok: false }> => !o.ok);
    if (failed.length === 0) {
      if (recovered && !(await editSourceStillCurrent(fs, abs, content))) {
        return err(`${path} changed while the edits were being prepared. Inspect the affected lines and retry the batch.`);
      }
      await fs.writeFile(abs, current);
      markOverlay(ctx, resolved.projectId, resolved.relativePath, resolved.external);
      emitRecentFileTouched({ absolutePath: abs, kind: 'edit' });
      const summary = outcomes
        .filter((o): o is Extract<EditOutcome, { ok: true }> => o.ok)
        .map((a) => `  #${a.index + 1}: ${a.occurrences} replacement${a.occurrences === 1 ? '' : 's'} [${a.strategy}]`)
        .join('\n');
      return ok(`Edited ${path} — ${outcomes.length} edit${outcomes.length === 1 ? '' : 's'} applied atomically:\n${summary}`);
    }

    // Atomic rollback path: write nothing, but surface EVERY problem
    // at once.
    const lines: string[] = [];
    lines.push(
      `multi_edit aborted: ${failed.length} of ${edits.length} edit${edits.length === 1 ? '' : 's'} failed. ` +
        'Nothing was written to disk. Fix every failing edit below and re-submit the whole list.',
    );
    lines.push('');
    for (const o of outcomes) {
      if (o.ok) {
        lines.push(`  #${o.index + 1}: would succeed [${o.strategy}, ${o.occurrences} occurrence${o.occurrences === 1 ? '' : 's'}]`);
      } else {
        const dep = o.dependsOnPrior
          ? ' (may also be a downstream effect of an earlier failed edit — re-validate after fixing the first one)'
          : '';
        const [summary, ...details] = o.error.split('\n');
        lines.push(`  #${o.index + 1}: FAILED — ${summary}${dep}`, ...details);
      }
    }
    return err(lines.join('\n'));
  },
};

export const fsTools: CoderTool[] = [
  writeFile,
  createFile,
  editFile,
  multiEdit,
  managePathTool,
  readFile,
  listDirectory,
];
