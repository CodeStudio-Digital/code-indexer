import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { IFilesystemPort } from '@mcp/code-agent/ports/filesystem-port.js';
import { LocalFilesystemAdapter } from '@mcp/code-agent/ports/filesystem-port.js';

/**
 * Path-safe slug — lowercase ascii + digits + hyphens, capped at 60 chars.
 * Local to this module on purpose: the existing `slugify` in
 * `skills/agent-skills-parser.ts` is private to that file, and pulling a new
 * shared util in just for this single call site would be over-engineering.
 */
export function slugifySpecName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'spec';
}

/**
 * Compute the repo-relative path the runner will persist a spec at.
 * Shape: `.mcp/specs/<slug>-<unix>.md`.
 */
export function buildSpecPath(name: string, nowMs: number = Date.now()): {
  relPath: string;
  fileName: string;
  unix: number;
} {
  const slug = slugifySpecName(name);
  const unix = Math.floor(nowMs / 1000);
  const fileName = `${slug}-${unix}.md`;
  return { relPath: `.mcp/specs/${fileName}`, fileName, unix };
}

const FALLBACK_FS: IFilesystemPort = new LocalFilesystemAdapter();

/**
 * Write the spec body under `<cwd>/.mcp/specs/<slug>-<unix>.md`, creating
 * the directory if needed. Uses the session's `ports.fs` so sandboxed
 * sessions write into the container, falling back to the local adapter
 * when ports are unbound (tests, chat-only sessions).
 */
export async function writeSpecToRepo(
  ctx: ToolContext,
  name: string,
  body: string,
): Promise<{ absPath: string; relPath: string; fileName: string }> {
  const base = buildSpecPath(name);
  // Multiple drafts may be submitted in one second. Each review must retain
  // its own immutable artifact, even when the model reuses the same title.
  const fileName = base.fileName.replace(/\.md$/, `-${randomUUID()}.md`);
  const relPath = `.mcp/specs/${fileName}`;
  const absPath = isAbsolute(relPath) ? relPath : resolve(ctx.cwd, relPath);
  const fs = ctx.ports?.fs ?? FALLBACK_FS;
  if (!fs.createFile) throw new Error('Specification storage requires exclusive file creation');
  ctx.signal?.throwIfAborted();
  await fs.mkdir(dirname(absPath), { recursive: true });
  ctx.signal?.throwIfAborted();
  await fs.createFile(absPath, body);
  return { absPath, relPath, fileName };
}
