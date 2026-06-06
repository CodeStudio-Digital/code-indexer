import { existsSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { Project, SearchMode } from '@mcp/shared/types.js';
import { ProjectError } from './errors.js';

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  group_name?: string | null;
  root_path?: string;
  embeddings_enabled?: number;
  search_mode?: SearchMode;
  node_version?: string | null;
  runner_shell?: string | null;
  memory_enabled?: boolean;
}

const VALID_SEARCH_MODES: ReadonlySet<string> = new Set(['fts', 'vector', 'hybrid']);

/**
 * Update a project — validates each patch field in isolation. Missing fields
 * are simply skipped (PATCH semantics). Throws `ProjectError` for invalid or
 * conflicting input.
 */
export class UpdateProjectService {
  constructor(private readonly db: CodeIndexDB) {}

  execute(id: number, patch: UpdateProjectInput): Project | undefined {
    const project = this.db.getProject(id);
    if (!project) throw new ProjectError('not_found', 'Not found');

    const updates: UpdateProjectInput = {};

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new ProjectError('invalid_input', 'name cannot be empty');
      const existing = this.db.getProjectByName(name);
      if (existing && existing.id !== id) {
        throw new ProjectError('conflict', `Project name "${name}" already in use`);
      }
      updates.name = name;
    }

    if (patch.description !== undefined) {
      updates.description = patch.description;
    }

    if (patch.group_name !== undefined) {
      updates.group_name = patch.group_name || null;
    }

    if (patch.root_path !== undefined) {
      const absPath = resolvePath(patch.root_path);
      if (!existsSync(absPath) || !statSync(absPath).isDirectory()) {
        throw new ProjectError('invalid_input', `root_path "${absPath}" is not an existing directory`);
      }
      const existing = this.db.getProjectByPath(absPath);
      if (existing && existing.id !== id) {
        throw new ProjectError('conflict', `root_path "${absPath}" already used by another project`);
      }
      updates.root_path = absPath;
    }

    if (patch.embeddings_enabled !== undefined) {
      if (patch.embeddings_enabled !== 0 && patch.embeddings_enabled !== 1) {
        throw new ProjectError('invalid_input', 'embeddings_enabled must be 0 or 1');
      }
      updates.embeddings_enabled = patch.embeddings_enabled;
    }

    if (patch.search_mode !== undefined) {
      if (!VALID_SEARCH_MODES.has(patch.search_mode as string)) {
        throw new ProjectError('invalid_input', 'search_mode must be one of: fts, vector, hybrid');
      }
      updates.search_mode = patch.search_mode;
    }

    if (patch.node_version !== undefined) {
      // Opaque runtime id resolved at spawn time; empty string → system default.
      updates.node_version = patch.node_version || null;
    }

    if (patch.runner_shell !== undefined) {
      // Opaque shell id resolved at spawn time; empty string → system default.
      updates.runner_shell = patch.runner_shell || null;
    }

    if (patch.memory_enabled !== undefined) {
      // Dedicated column setter (not part of the generic `updates` whitelist);
      // safe alongside an empty `updates` since updateProject no-ops on [].
      this.db.setProjectMemoryEnabled(id, patch.memory_enabled);
    }

    this.db.updateProject(id, updates);
    return this.db.getProject(id);
  }
}
