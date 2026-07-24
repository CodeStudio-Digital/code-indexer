import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { err, ok } from '@mcp/code-agent/core/tool.js';
import {
  defaultLocalFilesystemPort,
  type IFilesystemPort,
} from '@mcp/code-agent/ports/filesystem-port.js';
import { MANAGE_PATH_DESC, maybeTerse } from '@mcp/code-agent/tools/descriptions.js';
import { emitRecentFileTouched } from '@mcp/code-agent/tools/global-recent-files.js';
import { pathFor, resolveAuthorizedPath } from '@mcp/code-agent/tools/paths.js';

type Operation = 'mkdir' | 'move' | 'delete';
type DeleteMode = 'trash' | 'permanent';

const BLOCKED_TOP_LEVEL = new Set(['.git', '.mcp-indexer', 'node_modules']);

function fsPort(ctx: ToolContext): IFilesystemPort {
  return ctx.ports?.fs ?? defaultLocalFilesystemPort();
}

function cleanInput(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function hasTraversal(value: string): boolean {
  return value.split(/[\\/]+/).some((part) => part === '..');
}

function safeTarget(raw: unknown, ctx: ToolContext): {
  abs: string;
  rel: string;
  display: string;
  rootPath: string;
  external: boolean;
} | { error: string } {
  const input = cleanInput(raw);
  if (!input) return { error: 'Path is required' };
  if (hasTraversal(input)) return { error: `Path '${input}' uses traversal segments` };

  const resolved = resolveAuthorizedPath(input, ctx.cwd, ctx.externalRoots, 'write');
  if (!resolved.ok) return { error: resolved.reason };
  const rel = resolved.relativePath;
  if (!rel || rel === '.') return { error: 'Refusing to operate on the project root' };

  const top = rel.split('/').filter(Boolean)[0]?.toLowerCase();
  if (top && BLOCKED_TOP_LEVEL.has(top)) {
    return { error: `Refusing to operate on protected path '${top}'` };
  }

  return {
    abs: resolved.abs,
    rel,
    display: resolved.external ? resolved.abs : rel,
    rootPath: resolved.rootPath,
    external: resolved.external,
  };
}

async function exists(fs: IFilesystemPort, abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

async function isNonEmptyDirectory(fs: IFilesystemPort, abs: string): Promise<boolean> {
  const entries = await fs.readdir(abs, { withFileTypes: true });
  return entries.length > 0;
}

function trashPath(rootPath: string, rel: string): { abs: string; rel: string } {
  const p = pathFor(rootPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parts = rel.split('/').filter(Boolean);
  const trashRel = ['.mcp-indexer', 'trash', `${stamp}-${Date.now()}`, ...parts].join('/');
  return {
    abs: p.resolve(rootPath, ...trashRel.split('/')),
    rel: trashRel,
  };
}

async function mkdir(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const target = safeTarget(args.path, ctx);
  if ('error' in target) return err(target.error);

  const fs = fsPort(ctx);
  const alreadyExists = await exists(fs, target.abs);
  if (alreadyExists) {
    const st = await fs.stat(target.abs);
    if (!st.isDirectory()) return err(`Path '${target.display}' already exists and is not a directory`);
  }
  await fs.mkdir(target.abs, { recursive: true });
  if (!target.external) ctx.overlay?.mark(target.rel);
  emitRecentFileTouched({ absolutePath: target.abs, kind: 'edit' });
  return ok(`${alreadyExists ? 'Directory already exists' : 'Created directory'}: ${target.display}`);
}

async function move(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const from = safeTarget(args.from_path, ctx);
  if ('error' in from) return err(`from_path: ${from.error}`);
  const to = safeTarget(args.to_path, ctx);
  if ('error' in to) return err(`to_path: ${to.error}`);
  if (from.rootPath.toLowerCase() !== to.rootPath.toLowerCase()) {
    return err('Moves across project/external root boundaries are not allowed');
  }

  const fs = fsPort(ctx);
  if (!(await exists(fs, from.abs))) return err(`Source '${from.display}' does not exist`);
  if (await exists(fs, to.abs)) return err(`Destination '${to.display}' already exists`);

  const fromStats = await fs.stat(from.abs);
  if (fromStats.isDirectory() && (to.rel === from.rel || to.rel.startsWith(`${from.rel}/`))) {
    return err(`Refusing to move '${from.display}' into itself`);
  }

  const p = pathFor(to.rootPath);
  await fs.mkdir(p.dirname(to.abs), { recursive: true });
  await fs.rename(from.abs, to.abs);
  if (!from.external) {
    ctx.overlay?.mark(from.rel);
    ctx.overlay?.mark(to.rel);
  }
  emitRecentFileTouched({ absolutePath: from.abs, kind: 'edit' });
  emitRecentFileTouched({ absolutePath: to.abs, kind: 'edit' });
  return ok(`Moved ${from.display} -> ${to.display}`);
}

async function deletePath(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const target = safeTarget(args.path, ctx);
  if ('error' in target) return err(target.error);

  const fs = fsPort(ctx);
  if (!(await exists(fs, target.abs))) return err(`Path '${target.display}' does not exist`);

  const mode = cleanInput(args.delete_mode) === 'permanent' ? 'permanent' : 'trash';
  const recursive = Boolean(args.recursive);
  const confirm = cleanInput(args.confirm);
  const st = await fs.stat(target.abs);

  if (st.isDirectory() && !recursive && (await isNonEmptyDirectory(fs, target.abs))) {
    return err(`Directory '${target.display}' is not empty. Set recursive=true and confirm 'DELETE ${target.display}'.`);
  }

  if (mode === 'permanent') {
    const expected = `PERMANENT DELETE ${target.display}`;
    if (confirm !== expected) return err(`Permanent delete requires confirm='${expected}'`);
    await fs.rm(target.abs, { recursive, force: false });
    if (!target.external) ctx.overlay?.mark(target.rel);
    emitRecentFileTouched({ absolutePath: target.abs, kind: 'edit' });
    return ok(`Deleted permanently: ${target.display}`);
  }

  if (recursive) {
    const expected = `DELETE ${target.display}`;
    if (confirm !== expected) return err(`Recursive delete requires confirm='${expected}'`);
  }

  const trash = trashPath(target.rootPath, target.rel);
  const p = pathFor(target.rootPath);
  await fs.mkdir(p.dirname(trash.abs), { recursive: true });
  await fs.rename(target.abs, trash.abs);
  if (!target.external) ctx.overlay?.mark(target.rel);
  emitRecentFileTouched({ absolutePath: target.abs, kind: 'edit' });
  return ok(`Moved ${target.display} to trash: ${trash.abs}`);
}

export const managePathTool: CoderTool = {
  name: 'manage_path',
  effectBoundary: 'filesystem',
  description: maybeTerse(MANAGE_PATH_DESC),
  source: 'native',
  mutates: true,
  parallelSafe: false,
  riskLevel: 'write',
  scopeAware: true,
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['mkdir', 'move', 'delete'],
        description:
          "Which args each operation requires — 'mkdir': path; 'move': from_path + to_path; " +
          "'delete': path (+ recursive and confirm for non-empty dirs, delete_mode defaults to trash).",
      },
      path: { type: 'string', description: 'Project-relative path, or absolute path under an authorized writable external root, for mkdir/delete' },
      from_path: { type: 'string', description: 'Project-relative or authorized writable external source path for move' },
      to_path: { type: 'string', description: 'Project-relative or authorized writable external destination path for move (same root as source)' },
      recursive: { type: 'boolean', description: 'Required for non-empty directory deletes' },
      delete_mode: { type: 'string', enum: ['trash', 'permanent'], description: 'Defaults to trash' },
      confirm: { type: 'string', description: "Exact confirmation string for recursive/permanent deletes" },
    },
    required: ['operation'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const operation = cleanInput(args.operation) as Operation;
    if (operation === 'mkdir') return await mkdir(args, ctx);
    if (operation === 'move') return await move(args, ctx);
    if (operation === 'delete') return await deletePath(args, ctx);
    return err("operation must be one of 'mkdir', 'move', or 'delete'");
  },
};
