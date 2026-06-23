/**
 * Resolves where host-scaffolded projects land:
 * `<mcpDataDir>/projects/<slug>` — i.e. `~/.mcp-code-indexer/projects/<slug>`
 * by default, the same canonical data dir the rest of the app uses (index
 * db, exports). Overridable directly with `MCP_USER_PROJECTS_DIR`, or
 * indirectly via `MCP_DATA_DIR`.
 *
 * Collision handling keeps the directory slug and the project name in
 * lockstep (both get the same `-2`/`-3` suffix) so registration via
 * `CreateProjectService` — which enforces a unique name — never fails
 * after a successful scaffold.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import { slugify } from './slugify.js';

/** Base directory that holds every host-scaffolded project. */
export function userProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MCP_USER_PROJECTS_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(mcpDataDir(env), 'projects');
}

export interface ResolvedTarget {
  /** Final folder name (collision-suffixed). */
  slug: string;
  /** Display name, suffixed in lockstep with the slug. */
  name: string;
  /** Absolute path: `<root>/<slug>`. */
  targetPath: string;
}

export interface ResolveTargetOptions {
  /** Override the base dir (tests). Defaults to `userProjectsRoot()`. */
  root?: string;
  /** True when a project with this display name already exists in the DB. */
  isNameTaken?: (name: string) => boolean;
}

/**
 * Turn a user-supplied name into a free `{ slug, name, targetPath }`.
 * Ensures BOTH the on-disk directory and the DB name are unoccupied,
 * suffixing `-2`, `-3`, … until both are free. Creates the base root
 * (`mkdir -p`) but NOT the slug dir — most CLIs (create-vite,
 * create-next-app) require their target to not pre-exist.
 */
export function resolveTargetPath(name: string, opts: ResolveTargetOptions = {}): ResolvedTarget {
  const root = opts.root ?? userProjectsRoot();
  const isNameTaken = opts.isNameTaken ?? (() => false);
  mkdirSync(root, { recursive: true });

  const baseSlug = slugify(name);
  const baseName = name.trim() || baseSlug;

  for (let i = 1; i < 1_000; i++) {
    const slug = i === 1 ? baseSlug : `${baseSlug}-${i}`;
    const display = i === 1 ? baseName : `${baseName} ${i}`;
    const targetPath = path.join(root, slug);
    if (!existsSync(targetPath) && !isNameTaken(display)) {
      return { slug, name: display, targetPath };
    }
  }
  // Astronomically unlikely; fail loudly rather than loop forever.
  throw new Error(`Could not find a free project slot for "${name}" under ${root}`);
}
