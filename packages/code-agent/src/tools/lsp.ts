import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { getTsService, isTsFile } from '@mcp/code-agent/lsp/ts-service.js';
import { getGlobalAgentLspBackend, type AgentLspLocation } from '@mcp/code-agent/lsp/agent-lsp-backend.js';
import { resolveProjectFile as resolveProjectFilePath } from '@mcp/code-agent/tools/paths.js';

/**
 * LSP tools — multi-language.
 *
 * TS/JS run on the in-process TypeScript language service (same engine as
 * tsserver, zero IPC). Every OTHER language routes through the global
 * AgentLspBackend (wired by the host): installed LSP servers
 * (PHP/Intelephense, Python/Pyright, …) when available, otherwise the
 * structural-index fallback (tree-sitter symbols with exact line/col).
 * No backend wired (tests, stripped hosts) → honest "TS only" error.
 *
 * Why 1-based line/column? That's what editors show and what the rest of
 * the agent outputs (grep, diagnostics, stack traces). Converting internally
 * is cheap; making the agent juggle 0-based offsets would be hostile.
 */

function viaBackend(
  op: 'definition' | 'references' | 'hover',
  rel: string,
  ctx: ToolContext,
  line: number,
  column: number,
): Promise<AgentLspLocation[] | { contents: string } | null> | null {
  const backend = getGlobalAgentLspBackend();
  if (!backend) return null;
  const input = { root: ctx.cwd, projectName: ctx.projectName, file: rel, position: { line, column } };
  return backend[op](input) as Promise<AgentLspLocation[] | { contents: string } | null>;
}

function formatLocations(kind: string, locs: AgentLspLocation[], origin: string): string {
  const lines = [`Found ${locs.length} ${kind}(s):`];
  for (const l of locs.slice(0, 50)) {
    lines.push(`  ${l.file}:${l.range.start.line}:${l.range.start.column}`);
  }
  if (locs.length > 50) lines.push(`  … ${locs.length - 50} more`);
  lines.push(`(via ${origin})`);
  return lines.join('\n');
}

function resolveProjectFile(filePath: string, ctx: ToolContext): { abs: string; rel: string } | null {
  return resolveProjectFilePath(filePath, ctx.cwd);
}

function formatPosition(p: { file: string; line: number; column: number }): string {
  return `${p.file}:${p.line}:${p.column}`;
}

// ── lsp_definition ───────────────────────────────

const lspDefinition: CoderTool = {
  name: 'lsp_definition',
  description:
    'Go to definition: find where a symbol is declared. TS/JS use the in-process TypeScript service; other languages (PHP, Python, Go, …) route through installed language servers or the structural index.\n' +
    "USE: to jump from a call site / reference to the actual declaration of a function, class, type, or variable.\n" +
    "USE: as a faster alternative to mcp__get_symbol_body when you have a precise (line, column) already.\n" +
    "DON'T: use without knowing the exact line/column — call mcp__grep_code or mcp__search first.\n" +
    '1-based line and column, matching what editors and stack traces show.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Project-relative path to a .ts/.tsx/.js/.jsx file.' },
      line: { type: 'number', description: '1-based line number of the symbol to resolve.' },
      column: { type: 'number', description: '1-based column number of the symbol to resolve.' },
    },
    required: ['file_path', 'line', 'column'],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const file = String(args.file_path ?? '').trim();
    const line = Number(args.line);
    const column = Number(args.column);
    if (!file || !Number.isFinite(line) || !Number.isFinite(column)) {
      return err('file_path, line, column are required (line/column are 1-based)');
    }
    const resolved = resolveProjectFile(file, ctx);
    if (!resolved) return err(`file not found or outside project root: ${file}`);
    if (!isTsFile(file)) {
      const call = viaBackend('definition', resolved.rel, ctx, line, column);
      if (!call) return err(`lsp_definition: no multi-language backend wired in this context — use mcp__find_references for ${file}`);
      const locs = (await call) as AgentLspLocation[] | null;
      if (!locs || locs.length === 0) return ok(`No definition found at ${resolved.rel}:${line}:${column}`);
      return ok(formatLocations('definition', locs, 'language server / structural index'));
    }
    try {
      const svc = getTsService(ctx.cwd);
      const result = svc.getDefinition(resolved.rel, line, column);
      if (result.targets.length === 0) {
        return ok(`No definition found at ${resolved.rel}:${line}:${column}`);
      }
      return ok(`Found ${result.targets.length} definition(s):\n${result.targets.map(formatPosition).join('\n')}`);
    } catch (e) {
      return err(`lsp_definition failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

// ── lsp_references ───────────────────────────────

const lspReferences: CoderTool = {
  name: 'lsp_references',
  description:
    'Find all references to a symbol using the in-process TypeScript language service.\n' +
    "USE: to answer 'where is this used?' across the whole project — semantically, not textually.\n" +
    "USE: before renaming/removing a symbol, to audit impact.\n" +
    "DON'T: use grep/mcp__grep_code for this — grep matches text, LSP matches the actual symbol, so it skips comments, shadowed names, and identically-named symbols in other scopes.\n" +
    'Non-TS/JS files route through installed language servers (PHP/Python) or the structural index.\n' +
    '1-based line and column.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Project-relative path to a .ts/.tsx/.js/.jsx file.' },
      line: { type: 'number', description: '1-based line number.' },
      column: { type: 'number', description: '1-based column number.' },
    },
    required: ['file_path', 'line', 'column'],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const file = String(args.file_path ?? '').trim();
    const line = Number(args.line);
    const column = Number(args.column);
    if (!file || !Number.isFinite(line) || !Number.isFinite(column)) {
      return err('file_path, line, column are required (line/column are 1-based)');
    }
    const resolved = resolveProjectFile(file, ctx);
    if (!resolved) return err(`file not found or outside project root: ${file}`);
    if (!isTsFile(file)) {
      const call = viaBackend('references', resolved.rel, ctx, line, column);
      if (!call) return err(`lsp_references: no multi-language backend wired in this context — use mcp__find_references for ${file}`);
      const locs = (await call) as AgentLspLocation[] | null;
      if (!locs || locs.length === 0) return ok(`No references found for symbol at ${resolved.rel}:${line}:${column}`);
      return ok(formatLocations('reference', locs, 'language server / structural index'));
    }
    try {
      const svc = getTsService(ctx.cwd);
      const result = svc.getReferences(resolved.rel, line, column);
      if (result.references.length === 0) {
        return ok(`No references found for symbol at ${resolved.rel}:${line}:${column}`);
      }
      const lines: string[] = [`Found ${result.references.length} reference(s):`];
      for (const r of result.references) {
        const suffix = r.isWriteAccess ? '  [write]' : '';
        lines.push(`  ${formatPosition(r)}${suffix}`);
      }
      return ok(lines.join('\n'));
    } catch (e) {
      return err(`lsp_references failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

// ── lsp_hover ─────────────────────────────────────

const lspHover: CoderTool = {
  name: 'lsp_hover',
  description:
    'Get the inferred type and documentation for a symbol (hover info) using the TypeScript language service.\n' +
    "USE: to check the actual type of a variable/parameter when it's not obvious from the source (inferred generics, utility types, overloads).\n" +
    "USE: to read the JSDoc attached to a function/class without opening the definition.\n" +
    "DON'T: use as a substitute for reading the source — hover gives types, not implementation. Use lsp_definition or mcp__get_symbol_body for the body.\n" +
    'Non-TS/JS files route through installed language servers (PHP/Python) or the structural index.\n' +
    '1-based line and column.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Project-relative path to a .ts/.tsx/.js/.jsx file.' },
      line: { type: 'number', description: '1-based line number.' },
      column: { type: 'number', description: '1-based column number.' },
    },
    required: ['file_path', 'line', 'column'],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const file = String(args.file_path ?? '').trim();
    const line = Number(args.line);
    const column = Number(args.column);
    if (!file || !Number.isFinite(line) || !Number.isFinite(column)) {
      return err('file_path, line, column are required (line/column are 1-based)');
    }
    const resolved = resolveProjectFile(file, ctx);
    if (!resolved) return err(`file not found or outside project root: ${file}`);
    if (!isTsFile(file)) {
      const call = viaBackend('hover', resolved.rel, ctx, line, column);
      if (!call) return err(`lsp_hover: no multi-language backend wired in this context — use mcp__get_symbol_body for ${file}`);
      const hover = (await call) as { contents: string } | null;
      if (!hover?.contents) return ok(`No symbol info at ${resolved.rel}:${line}:${column}`);
      return ok(hover.contents);
    }
    try {
      const svc = getTsService(ctx.cwd);
      const info = svc.getHover(resolved.rel, line, column);
      if (!info) return ok(`No symbol info at ${resolved.rel}:${line}:${column}`);
      const parts: string[] = [`kind: ${info.kind}`, '', info.displayString];
      if (info.documentation) {
        parts.push('', 'documentation:', info.documentation);
      }
      return ok(parts.join('\n'));
    } catch (e) {
      return err(`lsp_hover failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

// ── lsp_diagnostics ───────────────────────────────

const lspDiagnostics: CoderTool = {
  name: 'lsp_diagnostics',
  description:
    'TypeScript/JavaScript ONLY — syntactic + semantic diagnostics for a single .ts/.tsx/.js/.jsx file (for PHP/Python/Go/Rust call get_diagnostics instead).\n' +
    "USE: after editing a .ts/.tsx/.js/.jsx file to catch type errors, unused symbols, and syntax mistakes. Much faster than running the full `tsc --noEmit` project-wide.\n" +
    "USE: before running tests — type errors surface here first and cheaper.\n" +
    "DON'T: expect runtime-behaviour errors. This only catches what TypeScript's checker catches.\n" +
    "DON'T: use on non-TS/JS files — call get_diagnostics for every other language (telemetry: 19 wasted calls on PHP files).\n" +
    'Returns a list of `file:line:col [severity] CODE: message` entries, or "No diagnostics" when clean.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Project-relative path to a .ts/.tsx/.js/.jsx file.' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const file = String(args.file_path ?? '').trim();
    if (!file) return err('file_path cannot be empty');
    if (!isTsFile(file)) {
      return err(`lsp_diagnostics only supports TypeScript/JavaScript files. Got: ${file}. Use get_diagnostics for other languages.`);
    }
    const resolved = resolveProjectFile(file, ctx);
    if (!resolved) return err(`file not found or outside project root: ${file}`);
    try {
      const svc = getTsService(ctx.cwd);
      const diags = svc.getDiagnostics(resolved.rel);
      if (diags.length === 0) return ok(`No diagnostics for ${resolved.rel}.`);
      const lines = diags.map(
        (d) => `${d.file}:${d.line}:${d.column}  [${d.severity}] TS${d.code}: ${d.message}`,
      );
      return ok(lines.join('\n'));
    } catch (e) {
      return err(`lsp_diagnostics failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const lspTools: CoderTool[] = [lspDefinition, lspReferences, lspHover, lspDiagnostics];
