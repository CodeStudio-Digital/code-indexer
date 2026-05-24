/**
 * Handlers for the `files` namespace. Wraps the existing DB lookups
 * (apps/http-api/server/routes/files.ts) and adds three new operations
 * the IDE workspace needs:
 *
 *   - `read`  — raw file contents (Monaco opens a file)
 *   - `write` — persist edits (Ctrl+S)
 *   - `tree`  — recursive directory listing for the FileTreeRail
 *
 * Read/write are scoped to the project's `root_path` with strict path
 * traversal protection. The DB-backed `list` is still the right call
 * for "indexed files" queries; `tree` walks the filesystem live.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ApiError, type FilesApi, type FileTreeNode } from '@mcp/api-bus';
import { detectManifest } from '@mcp/services/sandbox/manifest-detector/detect.js';
import { detectDockerfile } from '@mcp/services/sandbox/dockerfile-detector.js';
import type { HandlerDeps } from '../types.js';

/**
 * Default directory blocklist for `tree`. Anything matching is hidden
 * to keep the IDE's file explorer responsive (a `node_modules` walk
 * would dominate the response).
 */
const TREE_BLOCK = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.cache',
  '.venv', 'venv', '__pycache__', '.pytest_cache', 'target', '.idea',
  '.vscode', '.DS_Store',
]);

/**
 * Resolve a project-relative path to an absolute one, refusing any
 * resolved path that escapes the project's `root_path`. Returns the
 * absolute path. Throws ApiError(403) on traversal attempts.
 */
function resolveSafe(rootPath: string, rel: string): string {
  const normalizedRoot = path.resolve(rootPath);
  const candidate = path.resolve(normalizedRoot, rel);
  // path.relative returns '..' if the candidate escapes root.
  const inside = path.relative(normalizedRoot, candidate);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new ApiError('path_escape', 403, 'path escapes project root');
  }
  return candidate;
}

export function createFilesHandlers(deps: HandlerDeps): FilesApi {
  const { db } = deps;

  function requireProject(projectId: number) {
    const project = db.getProject(projectId);
    if (!project) throw new ApiError('not_found', 404, 'project not found');
    return project;
  }

  return {
    async list({ projectId }) {
      return db.listFiles(projectId);
    },

    async manifest({ projectId }) {
      const project = requireProject(projectId);
      return {
        manifest: detectManifest(project.root_path),
        dockerfile: detectDockerfile(project.root_path),
      };
    },

    async get({ projectId, path: filePath }) {
      const file = db.getFile(projectId, filePath);
      if (!file) throw new ApiError('not_found', 404, 'file not found');
      const symbols = db.getSymbolsByFile(projectId, filePath);
      const dependencies = db.getDependencies(file.id);
      const dependents = db.getDependents(projectId, file.id);
      return { ...file, symbols, dependencies, dependents };
    },

    async read({ projectId, path: rel }) {
      const project = requireProject(projectId);
      const abs = resolveSafe(project.root_path, rel);
      try {
        const content = await fs.readFile(abs, 'utf8');
        return { content, encoding: 'utf8' as const };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new ApiError('not_found', 404, 'file not found on disk');
        }
        throw err;
      }
    },

    async write({ projectId, path: rel, content, encoding }) {
      const project = requireProject(projectId);
      const abs = resolveSafe(project.root_path, rel);
      const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
      // Ensure parent dir exists — saving a new file under a fresh folder
      // (common when scaffolding) shouldn't require a separate mkdir call.
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, buf);
      const stat = await fs.stat(abs);
      return { ok: true as const, last_modified: stat.mtime.toISOString() };
    },

    async delete({ projectId, path: rel, recursive }) {
      const project = requireProject(projectId);
      const abs = resolveSafe(project.root_path, rel);
      // Refuse to delete the project root or a path that resolves to it.
      if (abs === path.resolve(project.root_path)) {
        throw new ApiError('refuse_root_delete', 400, 'refusing to delete project root');
      }
      try {
        const stat = await fs.stat(abs);
        if (stat.isDirectory()) {
          await fs.rm(abs, { recursive: recursive ?? false, force: false });
        } else {
          await fs.unlink(abs);
        }
        return { ok: true as const };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') throw new ApiError('not_found', 404, 'file not found');
        if (code === 'ENOTEMPTY') {
          throw new ApiError('dir_not_empty', 409, 'directory is not empty (pass recursive: true)');
        }
        throw err;
      }
    },

    async rename({ projectId, from, to }) {
      const project = requireProject(projectId);
      const absFrom = resolveSafe(project.root_path, from);
      const absTo = resolveSafe(project.root_path, to);
      await fs.mkdir(path.dirname(absTo), { recursive: true });
      try {
        await fs.rename(absFrom, absTo);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new ApiError('not_found', 404, 'source path not found');
        }
        throw err;
      }
      let lastModified: string | null = null;
      try {
        const stat = await fs.stat(absTo);
        lastModified = stat.mtime.toISOString();
      } catch {
        /* renamed away (directory): mtime not meaningful */
      }
      return { ok: true as const, last_modified: lastModified };
    },

    async mkdir({ projectId, path: rel }) {
      const project = requireProject(projectId);
      const abs = resolveSafe(project.root_path, rel);
      await fs.mkdir(abs, { recursive: true });
      return { ok: true as const };
    },

    async tree({ projectId, maxDepth = 6, root = '.' }) {
      const project = requireProject(projectId);
      const startAbs = resolveSafe(project.root_path, root);

      async function walk(absPath: string, relPath: string, depth: number): Promise<FileTreeNode> {
        const name = path.basename(absPath) || project.name;
        const stat = await fs.stat(absPath).catch(() => null);
        if (!stat) {
          return { name, path: relPath, type: 'file' };
        }
        if (!stat.isDirectory()) {
          return { name, path: relPath, type: 'file' };
        }
        if (depth >= maxDepth) {
          return { name, path: relPath, type: 'dir' };
        }
        const entries = await fs.readdir(absPath, { withFileTypes: true }).catch(() => []);
        // Stable, case-insensitive ordering: dirs first, then files alphabetically.
        const filtered = entries.filter((e) => !TREE_BLOCK.has(e.name));
        filtered.sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        const children = await Promise.all(
          filtered.map((e) =>
            walk(path.join(absPath, e.name), path.posix.join(relPath, e.name), depth + 1),
          ),
        );
        return { name, path: relPath, type: 'dir', children };
      }

      // The root node carries '.' as its relative path so descendants
      // are reachable via plain posix joins (consistent across OSes).
      return walk(startAbs, root === '.' ? '' : root, 0);
    },

    async symbol({ id }) {
      const sym = db.getSymbolById(id);
      if (!sym) throw new ApiError('not_found', 404, 'symbol not found');
      return sym;
    },

    async symbolMembers({ id }) {
      const sym = db.getSymbolById(id);
      if (!sym) throw new ApiError('not_found', 404, 'symbol not found');
      return db.getClassMembers(sym.name, sym.project_id);
    },

    async listConcepts({ projectId }) {
      return db.listConcepts(projectId);
    },

    async conceptFiles({ projectId, concept }) {
      return db.getFilesByConcept(projectId, concept);
    },
  };
}
