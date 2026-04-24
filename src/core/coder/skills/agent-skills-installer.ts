/**
 * Installer for third-party Agent Skills repositories.
 *
 * Orchestrates:
 *   1. Fetch files from GitHub (tree + raw)
 *   2. Extract all files to {dataDir}/skills/{namespace}/ on disk
 *   3. Parse SKILL.md and commands/*.md into SkillDefinition rows
 *   4. Upsert into SkillStore with a `source_ref` pointing back to the repo/commit
 *
 * References are left on disk — the skill body carries their absolute
 * paths so the agent can lazily load them via its Read tool.
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fetchRepoSkillFiles, type FetchedRepoFile } from './github-fetcher.js';
import { parseSkillMarkdown, toSkillDefinition } from './agent-skills-parser.js';
import { parseMcpJson } from './mcp-json-parser.js';
import { SkillStore } from '../../../store/skill-store.js';
import { McpServerStore } from '../../../store/mcp-server-store.js';
import { loadConfig, ensureDataDir } from '../../../utils/config.js';

export interface InstalledSkillSummary {
  id: string;
  name: string;
  kind: 'skill' | 'command';
  slash_command: string | null;
}

export interface InstalledMcpSummary {
  id: string;
  name: string;
  transport: string;
}

export interface InstallResult {
  namespace: string;
  repo: string;
  commitSha: string;
  baseDir: string;
  installed: InstalledSkillSummary[];
  mcpServers: InstalledMcpSummary[];
  warnings: string[];
}

function deriveNamespace(repo: string, override?: string): string {
  if (override) return override.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const name = repo.split('/')[1] ?? 'skills';
  // "skills" is a generic suffix — prefer the owner for repos named "skills"
  if (name.toLowerCase() === 'skills') {
    return (repo.split('/')[0] ?? 'skills').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  }
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

function findReferenceFiles(
  allFiles: FetchedRepoFile[],
  skillDir: string,
  baseDir: string,
): string[] {
  const prefix = `${skillDir}/references/`;
  return allFiles
    .filter((f) => f.path.startsWith(prefix))
    .map((f) => join(baseDir, f.path));
}

export async function installFromGithub(opts: {
  repo: string;
  namespace?: string;
  ref?: string;
  overwrite?: boolean;
}): Promise<InstallResult> {
  const namespace = deriveNamespace(opts.repo, opts.namespace);
  const config = loadConfig();
  const dataDir = ensureDataDir();
  const baseDir = join(dataDir, 'skills', namespace);

  if (opts.overwrite) {
    await rm(baseDir, { recursive: true, force: true });
  }

  const { files, commitSha } = await fetchRepoSkillFiles({
    repo: opts.repo,
    ref: opts.ref,
    token: process.env.CODER_GITHUB_TOKEN,
  });

  if (files.length === 0) {
    throw new Error(
      `No SKILL.md or command files found in ${opts.repo}@${opts.ref ?? 'HEAD'}`,
    );
  }

  // Extract files to disk.
  await mkdir(baseDir, { recursive: true });
  for (const f of files) {
    const dest = join(baseDir, f.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, f.content, 'utf8');
  }

  // Parse + upsert.
  const store = new SkillStore(config.dbPath);
  const installed: InstalledSkillSummary[] = [];
  try {
    for (const f of files) {
      const isSkill = /(^|\/)SKILL\.md$/i.test(f.path);
      const isCommand = /(^|\/)commands\/[^/]+\.md$/i.test(f.path);
      if (!isSkill && !isCommand) continue;

      let parsed;
      try {
        parsed = parseSkillMarkdown(f.content, f.path);
      } catch (e) {
        console.warn(
          `[agent-skills-installer] skipping ${f.path}: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }

      const skillDir = isSkill ? dirname(f.path) : '';
      const referenceFiles = isSkill
        ? findReferenceFiles(files, skillDir, baseDir)
        : [];

      const input = toSkillDefinition({
        parsed,
        namespace,
        extractedBaseDir: baseDir,
        referenceFiles,
      });

      const stored = store.upsertSkill({
        ...input,
        source_ref: { repo: opts.repo, commit: commitSha, path: f.path },
      });
      installed.push({
        id: stored.id,
        name: stored.name,
        kind: parsed.kind,
        slash_command: stored.slash_command,
      });
    }
  } finally {
    store.close();
  }

  if (installed.length === 0) {
    throw new Error(
      `No valid SKILL.md or command files parsed from ${opts.repo}@${commitSha}`,
    );
  }

  // ─── Register MCP servers from `.mcp.json` if present ──────────
  const mcpServers: InstalledMcpSummary[] = [];
  const warnings: string[] = [];
  const mcpFile = files.find((f) => f.path.toLowerCase() === '.mcp.json');
  if (mcpFile) {
    try {
      const inputs = parseMcpJson(mcpFile.content, namespace);
      const mcpStore = new McpServerStore(config.dbPath);
      try {
        for (const input of inputs) {
          const existing = mcpStore.getServer(input.id);
          if (existing) {
            const cfg = (existing.config ?? {}) as {
              installed_by_namespace?: string;
            };
            if (cfg.installed_by_namespace !== namespace) {
              warnings.push(
                `MCP server id "${input.id}" already exists (unmanaged) — skipped`,
              );
              continue;
            }
            // Preserve user-configured auth on re-install.
            if (existing.auth_token) {
              input.auth_token = existing.auth_token;
              input.auth_type = existing.auth_type;
            }
          }
          const up = mcpStore.upsertServer(input);
          mcpServers.push({
            id: up.id,
            name: up.name,
            transport: up.transport,
          });
        }
      } finally {
        mcpStore.close();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[agent-skills-installer] .mcp.json parse failed: ${msg}`);
      warnings.push(`.mcp.json parse failed: ${msg}`);
    }
  }

  return {
    namespace,
    repo: opts.repo,
    commitSha,
    baseDir,
    installed,
    mcpServers,
    warnings,
  };
}

export interface UninstallResult {
  namespace: string;
  removed: number;
  mcpRemoved: number;
  baseDir: string;
}

export async function uninstallNamespace(namespace: string): Promise<UninstallResult> {
  const config = loadConfig();
  const dataDir = ensureDataDir();
  const baseDir = join(dataDir, 'skills', namespace);
  const store = new SkillStore(config.dbPath);
  let removed = 0;
  try {
    const skills = store.listSkills({ source: 'imported' });
    for (const s of skills) {
      const fromNamespace =
        (s.tags?.includes(namespace)) ||
        (s.author === namespace) ||
        (s.source_ref &&
          deriveNamespace(s.source_ref.repo) === namespace);
      if (fromNamespace) {
        store.deleteSkill(s.id);
        removed++;
      }
    }
  } finally {
    store.close();
  }

  // Also remove any MCP servers installed by this namespace.
  const mcpStore = new McpServerStore(config.dbPath);
  let mcpRemoved = 0;
  try {
    for (const srv of mcpStore.listServers()) {
      const cfg = (srv.config ?? {}) as { installed_by_namespace?: string };
      if (cfg.installed_by_namespace === namespace) {
        mcpStore.deleteServer(srv.id);
        mcpRemoved++;
      }
    }
  } finally {
    mcpStore.close();
  }

  await rm(baseDir, { recursive: true, force: true });
  return { namespace, removed, mcpRemoved, baseDir };
}

export interface InstalledNamespaceSummary {
  namespace: string;
  repo: string | null;
  commit: string | null;
  skillCount: number;
  commandCount: number;
  mcpCount: number;
}

export function listInstalledNamespaces(): InstalledNamespaceSummary[] {
  const config = loadConfig();
  const store = new SkillStore(config.dbPath);
  const bucket = new Map<string, InstalledNamespaceSummary>();
  try {
    const skills = store.listSkills({ source: 'imported' });
    for (const s of skills) {
      const ns = s.author ?? (s.source_ref ? deriveNamespace(s.source_ref.repo) : 'unknown');
      const entry = bucket.get(ns) ?? {
        namespace: ns,
        repo: s.source_ref?.repo ?? null,
        commit: s.source_ref?.commit ?? null,
        skillCount: 0,
        commandCount: 0,
        mcpCount: 0,
      };
      if (s.slash_command) entry.commandCount++;
      else entry.skillCount++;
      if (s.source_ref) {
        entry.repo = s.source_ref.repo;
        entry.commit = s.source_ref.commit;
      }
      bucket.set(ns, entry);
    }
  } finally {
    store.close();
  }

  // Count MCP servers per namespace
  const mcpStore = new McpServerStore(config.dbPath);
  try {
    for (const srv of mcpStore.listServers()) {
      const cfg = (srv.config ?? {}) as { installed_by_namespace?: string };
      const ns = cfg.installed_by_namespace;
      if (!ns) continue;
      const entry = bucket.get(ns) ?? {
        namespace: ns,
        repo: null,
        commit: null,
        skillCount: 0,
        commandCount: 0,
        mcpCount: 0,
      };
      entry.mcpCount++;
      bucket.set(ns, entry);
    }
  } finally {
    mcpStore.close();
  }

  return Array.from(bucket.values()).sort((a, b) =>
    a.namespace.localeCompare(b.namespace),
  );
}
