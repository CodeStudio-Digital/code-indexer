/**
 * Shared helpers for the `diagram_*` tools (the draw.io diagram capability).
 *
 * Diagrams are real `.drawio` files under a project-relative `diagrams/`
 * folder — durable, versionable artifacts. These helpers resolve safe paths,
 * pick the filesystem port (so builder/sandbox sessions write into the
 * container), and emit the runner events that open/refresh the live editor.
 *
 * Unlike the api-client tools, there is NO module-global store to re-wire in
 * the workers: every tool reads project state from `ctx.cwd` and writes via
 * the fs port, so registration is stateless.
 */
import type { ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { err } from '@mcp/code-agent/core/tool.js';
import { resolveSafe } from '@mcp/code-agent/tools/paths.js';
import {
  defaultLocalFilesystemPort,
  type IFilesystemPort,
} from '@mcp/code-agent/ports/filesystem-port.js';

/** Folder (project-relative) where diagram artifacts live. */
export const DIAGRAMS_DIR = 'diagrams';

/** Resolve the filesystem port; falls back to the local adapter (tests). */
export function fsPort(ctx: ToolContext): IFilesystemPort {
  return ctx.ports?.fs ?? defaultLocalFilesystemPort();
}

/**
 * Turn a free-form diagram name into a safe, stable file slug. Strips an
 * explicit `.drawio` suffix and any path parts, lowercases to kebab-case.
 */
export function slugifyName(name: string): string {
  const base = String(name ?? '')
    .trim()
    .replace(/^.*[\\/]/, '') // drop any path prefix
    .replace(/\.drawio$/i, '');
  const slug = base
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'diagram';
}

export interface DiagramPath {
  /** Forward-slash project-relative path, e.g. `diagrams/auth-flow.drawio`. */
  rel: string;
  /** Absolute path on the primary project root. */
  abs: string;
  /** The slug used (no extension). */
  slug: string;
}

/**
 * Resolve a diagram name to its `.drawio` path under {@link DIAGRAMS_DIR},
 * rejecting traversal. Accepts a bare name (`Auth flow`), a slug, or an
 * explicit `diagrams/<name>.drawio` relative path — all collapse to the slug.
 */
export function resolveDiagramPath(
  ctx: ToolContext,
  name: string,
): DiagramPath | { error: ToolResult } {
  const raw = String(name ?? '').trim();
  if (!raw) return { error: err('A diagram name is required.') };
  const slug = slugifyName(raw);
  const rel = `${DIAGRAMS_DIR}/${slug}.drawio`;
  const abs = resolveSafe(rel, ctx.cwd);
  if (!abs) return { error: err(`Unsafe diagram path: ${rel}`) };
  return { rel, abs, slug };
}

/** Absolute path of the diagrams directory (for mkdir / readdir). */
export function diagramsDirAbs(ctx: ToolContext): string | null {
  return resolveSafe(DIAGRAMS_DIR, ctx.cwd);
}

/** Absence is distinct from permission, cancellation and IO failures. */
export async function fileExists(port: IFilesystemPort, absPath: string): Promise<boolean> {
  try {
    await port.access(absPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Notify the renderer that a diagram changed (created/updated by the agent).
 * The SSE layer forwards this so the chat panel + editor open/refresh live.
 * Best-effort: `ctx.runner` is undefined in tests / subagents.
 */
export function emitDiagramChanged(ctx: ToolContext, path: string, xml: string): void {
  try {
    if (ctx.onDiagramChanged) ctx.onDiagramChanged({ path, xml });
    else ctx.runner?.emit('diagram_changed', { path, xml });
  } catch {
    /* best-effort — the file is the durable source of truth */
  }
}

