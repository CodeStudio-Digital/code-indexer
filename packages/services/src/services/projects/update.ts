import { existsSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { Project, SearchMode } from '@mcp/shared/types.js';
import type { EditorSettingsOverride } from '@mcp/shared/editor-settings.js';
import { parseRuntimeVersions } from '@mcp/shared/utils/runtime-versions.js';
import { PHP_LEVELS, PYTHON_LEVELS, snapToLevels, writeLanguageLevel } from '@mcp/shared/utils/language-levels.js';
import { serializeIndexIgnorePatterns, parseIndexIgnorePatterns } from '@mcp/shared/utils/index-ignore.js';
import { ProjectError } from './errors.js';

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  group_name?: string | null;
  root_path?: string;
  embeddings_enabled?: number;
  search_mode?: SearchMode;
  /** Per-project index ignore rules, stored as a JSON string array. */
  index_ignore_patterns?: string | null;
  node_version?: string | null;
  runner_shell?: string | null;
  memory_enabled?: boolean;
  /** Per-project PHP/Python runtime ids — JSON string `{"php":"managed:8.3.7"}`. */
  runtime_versions?: string | null;
  /** Per-project package-manager prefs — JSON `{"node":"pnpm","python":"poetry"}`. */
  package_managers?: string | null;
  /** Per-project, per-WSL-distro runtime ids — JSON `{"Ubuntu":{"node":"managed:20.11.0"}}`. */
  wsl_runtime_versions?: string | null;
  /** Per-project, per-WSL-distro package-manager prefs — JSON `{"Ubuntu":{"node":"npm"}}`. */
  wsl_package_managers?: string | null;
  /** LSP language level JSON (migration 157) — set here when synced from a runtime change. */
  language_levels?: string | null;
  editor_settings?: EditorSettingsOverride | null;
}

/** "8.3" out of a runtime id like 'managed:8.3.7' / 'homebrew:8.3.7'; undefined for 'system'. */
function minorFromRuntimeId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const ver = id.includes(':') ? id.slice(id.indexOf(':') + 1) : '';
  const m = /(\d+)\.(\d+)/.exec(ver);
  return m ? `${m[1]}.${m[2]}` : undefined;
}

/**
 * Sync the LSP language level to a freshly-chosen runtime: derive the minor
 * from the php/python runtime id and snap it onto the supported levels, so
 * Intelephense/Pyright analyse against the version the project actually runs.
 *
 * Only syncs a language whose runtime id ACTUALLY CHANGED in this PATCH
 * (`old` vs `next`) — otherwise a Python-only change (or a no-op re-save)
 * would clobber a language level the user pinned by hand for PHP, and
 * vice-versa. Returns the updated language_levels JSON, or undefined when
 * nothing changed/maps. The running LSP picks it up on its next (re)start.
 */
function syncLanguageLevels(
  nextRuntimeJson: string | null,
  oldRuntimeJson: string | null,
  currentLevels: string | null,
): string | undefined {
  const next = parseRuntimeVersions(nextRuntimeJson);
  const old = parseRuntimeVersions(oldRuntimeJson);
  let levels: string | null = currentLevels;
  let changed = false;
  const sync = (key: 'php' | 'python', supported: readonly string[]): void => {
    if (next[key] === old[key]) return; // this language's runtime didn't change
    const minor = minorFromRuntimeId(next[key]);
    if (!minor) return; // 'system'/cleared → leave the level as the user has it
    const lvl = snapToLevels(minor, supported);
    if (lvl) { levels = writeLanguageLevel(levels, key, lvl); changed = true; }
  };
  sync('php', PHP_LEVELS);
  sync('python', PYTHON_LEVELS);
  return changed ? (levels ?? undefined) : undefined;
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

    if (patch.index_ignore_patterns !== undefined) {
      const patterns = parseIndexIgnorePatterns(patch.index_ignore_patterns);
      updates.index_ignore_patterns = serializeIndexIgnorePatterns(patterns);
    }

    if (patch.node_version !== undefined) {
      // Opaque runtime id resolved at spawn time; empty string → system default.
      updates.node_version = patch.node_version || null;
    }

    if (patch.runner_shell !== undefined) {
      // Opaque shell id resolved at spawn time; empty string → system default.
      updates.runner_shell = patch.runner_shell || null;
    }

    if (patch.runtime_versions !== undefined) {
      // Opaque per-language runtime ids (JSON) resolved at spawn time; empty → null.
      updates.runtime_versions = patch.runtime_versions || null;
      // Keep the editor's LSP language level in step with a CHANGED runtime
      // (per-key diff so a manual language-level pin isn't clobbered).
      const synced = syncLanguageLevels(
        updates.runtime_versions ?? null,
        project.runtime_versions ?? null,
        project.language_levels,
      );
      if (synced !== undefined) updates.language_levels = synced;
    }

    if (patch.package_managers !== undefined) {
      // Opaque per-language manager prefs (JSON) consumed by the runner's
      // detect override + the dependency assistant; empty → null (auto-detect).
      updates.package_managers = patch.package_managers || null;
    }

    if (patch.wsl_runtime_versions !== undefined) {
      // Opaque per-distro runtime ids (JSON) resolved at spawn time for a WSL
      // shell; empty → null (distro default, no PATH injection).
      updates.wsl_runtime_versions = patch.wsl_runtime_versions || null;
    }

    if (patch.wsl_package_managers !== undefined) {
      // Opaque per-distro package-manager prefs (JSON) consumed by the runner's
      // detect override for a WSL shell; empty → null (auto-detect).
      updates.wsl_package_managers = patch.wsl_package_managers || null;
    }

    if (patch.memory_enabled !== undefined) {
      // Dedicated column setter (not part of the generic `updates` whitelist);
      // safe alongside an empty `updates` since updateProject no-ops on [].
      this.db.setProjectMemoryEnabled(id, patch.memory_enabled);
    }

    if (patch.editor_settings !== undefined) {
      if (patch.editor_settings !== null && (typeof patch.editor_settings !== 'object' || Array.isArray(patch.editor_settings))) {
        throw new ProjectError('invalid_input', 'editor_settings must be an object or null');
      }
      const encoded = JSON.stringify(patch.editor_settings);
      if (encoded.length > 16_384) throw new ProjectError('invalid_input', 'editor_settings is too large');
      updates.editor_settings = patch.editor_settings;
    }

    this.db.updateProject(id, updates);
    return this.db.getProject(id);
  }
}
