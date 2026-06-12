import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { err, ok } from '@mcp/code-agent/core/tool.js';
import {
  defaultLocalFilesystemPort,
  type IFilesystemPort,
} from '@mcp/code-agent/ports/filesystem-port.js';
import { MANAGE_PATH_DESC, maybeTerse } from '@mcp/code-agent/tools/descriptions.js';
import { emitRecentFileTouched } from '@mcp/code-agent/tools/global-recent-files.js';
import { pathFor, resolveSafe as resolveSafePath } from '@mcp/code-agent/tools/paths.js';

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

function safeTarget(raw: unknown, ctx: ToolContext): { abs: string; rel: string } | { error: string } {
  const input = cleanInput(raw);
  if (!input) return { error: 'Path is required' };
  if (hasTraversal(input)) return { error: `Path '${input}' uses traversal segments` };

  const p = pathFor(ctx.cwd);
  if (p.isAbsolute(input)) return { error: `Path '${input}' must be project-relative` };

  const abs = resolveSafePath(input, ctx.cwd);
  if (!abs) return { error: `Path '${input}' is outside project root` };

  const rel = p.relative(ctx.cwd, abs).replace(/\\/g, '/');
  if (!rel || rel === '.') return { error: 'Refusing to operate on the project root' };

  const top = rel.split('/').filter(Boolean)[0]?.toLowerCase();
  if (top && BLOCKED_TOP_LEVEL.has(top)) {
    return { error: `Refusing to operate on protected path '${top}'` };
  }

  return { abs, rel };
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

function trashPath(ctx: ToolContext, rel: string): { abs: string; rel: string } {
  const p = pathFor(ctx.cwd);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parts = rel.split('/').filter(Boolean);
  const trashRel = ['.mcp-indexer', 'trash', `${stamp}-${Date.now()}`, ...parts].join('/');
  return {
    abs: p.resolve(ctx.cwd, ...trashRel.split('/')),
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
    if (!st.isDirectory()) return err(`Path '${target.rel}' already exists and is not a directory`);
  }
  await fs.mkdir(target.abs, { recursive: true });
  ctx.overlay?.mark(target.rel);
  emitRecentFileTouched({ absolutePath: target.abs, kind: 'edit' });
  return ok(`${alreadyExists ? 'Directory already exists' : 'Created directory'}: ${target.rel}`);
}

async function move(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const from = safeTarget(args.from_path, ctx);
  if ('error' in from) return err(`from_path: ${from.error}`);
  const to = safeTarget(args.to_path, ctx);
  if ('error' in to) return err(`to_path: ${to.error}`);

  const fs = fsPort(ctx);
  if (!(await exists(fs, from.abs))) return err(`Source '${from.rel}' does not exist`);
  if (await exists(fs, to.abs)) return err(`Destination '${to.rel}' already exists`);

  const fromStats = await fs.stat(from.abs);
  if (fromStats.isDirectory() && (to.rel === from.rel || to.rel.startsWith(`${from.rel}/`))) {
    return err(`Refusing to move '${from.rel}' into itself`);
  }

  const p = pathFor(ctx.cwd);
  await fs.mkdir(p.dirname(to.abs), { recursive: true });
  await fs.rename(from.abs, to.abs);
  ctx.overlay?.mark(from.rel);
  ctx.overlay?.mark(to.rel);
  emitRecentFileTouched({ absolutePath: from.abs, kind: 'edit' });
  emitRecentFileTouched({ absolutePath: to.abs, kind: 'edit' });
  return ok(`Moved ${from.rel} -> ${to.rel}`);
}

async function deletePath(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const target = safeTarget(args.path, ctx);
  if ('error' in target) return err(target.error);

  const fs = fsPort(ctx);
  if (!(await exists(fs, target.abs))) return err(`Path '${target.rel}' does not exist`);

  const mode = cleanInput(args.delete_mode) === 'permanent' ? 'permanent' : 'trash';
  const recursive = Boolean(args.recursive);
  const confirm = cleanInput(args.confirm);
  const st = await fs.stat(target.abs);

  if (st.isDirectory() && !recursive && (await isNonEmptyDirectory(fs, target.abs))) {
    return err(`Directory '${target.rel}' is not empty. Set recursive=true and confirm 'DELETE ${target.rel}'.`);
  }

  if (mode === 'permanent') {
    const expected = `PERMANENT DELETE ${target.rel}`;
    if (confirm !== expected) return err(`Permanent delete requires confirm='${expected}'`);
    await fs.rm(target.abs, { recursive, force: false });
    ctx.overlay?.mark(target.rel);
    emitRecentFileTouched({ absolutePath: target.abs, kind: 'edit' });
    return ok(`Deleted permanently: ${target.rel}`);
  }

  if (recursive) {
    const expected = `DELETE ${target.rel}`;
    if (confirm !== expected) return err(`Recursive delete requires confirm='${expected}'`);
  }

  const trash = trashPath(ctx, target.rel);
  const p = pathFor(ctx.cwd);
  await fs.mkdir(p.dirname(trash.abs), { recursive: true });
  await fs.rename(target.abs, trash.abs);
  ctx.overlay?.mark(target.rel);
  emitRecentFileTouched({ absolutePath: target.abs, kind: 'edit' });
  return ok(`Moved ${target.rel} to trash: ${trash.rel}`);
}

export const managePathTool: CoderTool = {
  name: 'manage_path',
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
      path: { type: 'string', description: 'Project-relative path for mkdir/delete' },
      from_path: { type: 'string', description: 'Project-relative source path for move' },
      to_path: { type: 'string', description: 'Project-relative destination path for move' },
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
