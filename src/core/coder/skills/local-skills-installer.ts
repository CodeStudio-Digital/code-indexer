import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseSkillMarkdown, toSkillDefinition, type ParsedSkillFile } from './agent-skills-parser.js';
import { parseMcpJson } from './mcp-json-parser.js';
import { SkillStore } from '../../../store/skill-store.js';
import { McpServerStore } from '../../../store/mcp-server-store.js';
import { loadConfig, ensureDataDir } from '../../../utils/config.js';
import type {
  InstallResult,
  InstalledSkillSummary,
  InstalledMcpSummary,
} from './agent-skills-installer.js';

/** Lenient parser: falls back to extracting name from # H1 heading when frontmatter is absent. */
function parseSkillLenient(content: string, path: string): ParsedSkillFile {
  try {
    return parseSkillMarkdown(content, path);
  } catch {
    // No frontmatter — synthesise one from the first # heading or filename
    const h1 = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const fileStem = path.split('/').pop()?.replace(/\.md$/i, '') ?? 'skill';
    const name = h1 ?? fileStem;
    const kind: 'skill' | 'command' =
      path.startsWith('commands/') || path.includes('/commands/') ? 'command' : 'skill';
    return {
      kind,
      frontmatter: { name, description: '' },
      body: content.trim(),
      path,
    };
  }
}

function deriveNamespaceFromFolder(folderPath: string, override?: string): string {
  if (override) return override.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const name = basename(folderPath);
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'local';
}

async function collectFiles(folderPath: string): Promise<{ path: string; content: string }[]> {
  const entries = await readdir(folderPath, { recursive: true, withFileTypes: true });
  const result: { path: string; content: string }[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Build relative path with forward slashes for cross-platform regex matching
    const parentDir = (entry as any).parentPath ?? (entry as any).path ?? folderPath;
    const absPath = join(parentDir, entry.name);
    const rel = absPath.slice(folderPath.length).replace(/^[\\/]/, '').replace(/\\/g, '/');

    const isSkill = /(^|\/)SKILL\.md$/i.test(rel);
    const isCommand = /(^|\/)commands\/[^/]+\.md$/i.test(rel);
    const isReference = /(^|\/)references\/[^/]+\.md$/i.test(rel);
    const isMcp = rel.toLowerCase() === '.mcp.json';

    if (!isSkill && !isCommand && !isReference && !isMcp) continue;

    const content = await readFile(absPath, 'utf8');
    result.push({ path: rel, content });
  }

  return result;
}

export async function installFromLocalFolder(opts: {
  folderPath: string;
  namespace?: string;
  overwrite?: boolean;
}): Promise<InstallResult> {
  const folderStat = await stat(opts.folderPath).catch(() => null);
  if (!folderStat) {
    throw new Error(`Path not found: ${opts.folderPath}`);
  }
  if (!folderStat.isDirectory()) {
    throw new Error(`Path is not a directory: ${opts.folderPath}`);
  }

  const namespace = deriveNamespaceFromFolder(opts.folderPath, opts.namespace);
  const config = loadConfig();
  const dataDir = ensureDataDir();
  const baseDir = join(dataDir, 'skills', namespace);

  if (opts.overwrite) {
    await rm(baseDir, { recursive: true, force: true });
  }

  const files = await collectFiles(opts.folderPath);

  const skillFiles = files.filter((f) => {
    const isSkill = /(^|\/)SKILL\.md$/i.test(f.path);
    const isCommand = /(^|\/)commands\/[^/]+\.md$/i.test(f.path);
    return isSkill || isCommand;
  });

  if (skillFiles.length === 0) {
    throw new Error(`No SKILL.md or command files found in ${opts.folderPath}`);
  }

  // Copy files to managed dataDir so references are accessible by path
  await mkdir(baseDir, { recursive: true });
  for (const f of files) {
    const dest = join(baseDir, f.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, f.content, 'utf8');
  }

  const store = new SkillStore(config.dbPath);
  const installed: InstalledSkillSummary[] = [];
  const warnings: string[] = [];

  try {
    for (const f of files) {
      const isSkill = /(^|\/)SKILL\.md$/i.test(f.path);
      const isCommand = /(^|\/)commands\/[^/]+\.md$/i.test(f.path);
      if (!isSkill && !isCommand) continue;

      const parsed = parseSkillLenient(f.content, f.path);

      const skillDir = isSkill ? dirname(f.path).replace(/^\.?\/?$/, '') : '';
      const referencePrefix = skillDir ? `${skillDir}/references/` : 'references/';
      const referenceFiles = files
        .filter((rf) => rf.path.startsWith(referencePrefix))
        .map((rf) => join(baseDir, rf.path));

      const input = toSkillDefinition({
        parsed,
        namespace,
        extractedBaseDir: baseDir,
        referenceFiles,
      });

      const stored = store.upsertSkill({
        ...input,
        source_ref: { repo: 'local', commit: opts.folderPath, path: f.path },
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
    throw new Error(`No valid skill files could be parsed from ${opts.folderPath}`);
  }

  const mcpServers: InstalledMcpSummary[] = [];
  const mcpFile = files.find((f) => f.path.toLowerCase() === '.mcp.json');
  if (mcpFile) {
    try {
      const inputs = parseMcpJson(mcpFile.content, namespace);
      const mcpStore = new McpServerStore(config.dbPath);
      try {
        for (const input of inputs) {
          const existing = mcpStore.getServer(input.id);
          if (existing) {
            const cfg = (existing.config ?? {}) as { installed_by_namespace?: string };
            if (cfg.installed_by_namespace !== namespace) {
              warnings.push(`MCP server id "${input.id}" already exists (unmanaged) — skipped`);
              continue;
            }
            if (existing.auth_token) {
              input.auth_token = existing.auth_token;
              input.auth_type = existing.auth_type;
            }
          }
          const up = mcpStore.upsertServer(input);
          mcpServers.push({ id: up.id, name: up.name, transport: up.transport });
        }
      } finally {
        mcpStore.close();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`.mcp.json parse failed: ${msg}`);
    }
  }

  return {
    namespace,
    repo: `local:${opts.folderPath}`,
    commitSha: 'local',
    baseDir,
    installed,
    mcpServers,
    warnings,
  };
}
