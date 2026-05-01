/**
 * Installer for Agent Skills distributed as zip downloads from mcp.directory.
 *
 * Flow:
 *   1. Validate URL host against allowlist (mcp.directory only).
 *   2. Resolve URL to a direct download (auto-detect page vs /api/skills/download/<id>).
 *   3. Download to a temp file, capped at MAX_DOWNLOAD_BYTES.
 *   4. Extract via the shared extractZipToDir (path traversal / symlink / zip-bomb safe).
 *   5. Locate the skill root (directory containing SKILL.md, optionally one level deep).
 *   6. Copy files into {dataDir}/skills/{namespace}/ and upsert into SkillStore.
 *   7. Register .mcp.json servers if present.
 *   8. Cleanup temp paths in finally.
 *
 * source_ref shape:
 *   { repo: <full URL pasted by user>, commit: <download-id or sha256>, path: <relative file path> }
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { extractZipToDir } from '../../design-system/extract-zip.js';
import { parseSkillMarkdown, toSkillDefinition } from './agent-skills-parser.js';
import { parseMcpJson } from './mcp-json-parser.js';
import { SkillStore } from '../../../store/skill-store.js';
import { McpServerStore } from '../../../store/mcp-server-store.js';
import { loadConfig, ensureDataDir } from '../../../utils/config.js';
import type {
  InstallResult,
  InstalledSkillSummary,
  InstalledMcpSummary,
} from './agent-skills-installer.js';

const ALLOWED_HOSTS = new Set(['mcp.directory', 'www.mcp.directory']);
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_EXTRACTED_BYTES = 100 * 1024 * 1024; // 100 MB
const ALLOWED_CONTENT_TYPES = new Set([
  'application/zip',
  'application/octet-stream',
  'application/x-zip-compressed',
  'application/x-zip',
  'binary/octet-stream',
]);

interface ResolvedDownload {
  downloadUrl: string;
  /** Stable identifier for source_ref.commit when present (e.g. numeric id). */
  identifier: string | null;
  /** Slug derived from the page URL, used as namespace fallback. */
  slug: string | null;
}

function assertAllowedUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Only https:// URLs are allowed (got ${url.protocol})`);
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(
      `Host not allowed: ${url.hostname}. Allowed: ${Array.from(ALLOWED_HOSTS).join(', ')}`,
    );
  }
  return url;
}

async function resolveDownloadUrl(input: string): Promise<ResolvedDownload> {
  const url = assertAllowedUrl(input);
  const path = url.pathname.replace(/\/+$/, '');

  // /api/skills/download/<id> — already a direct download
  const directMatch = path.match(/^\/api\/skills\/download\/([\w-]+)$/);
  if (directMatch) {
    return {
      downloadUrl: url.toString(),
      identifier: directMatch[1],
      slug: null,
    };
  }

  // /skills/<slug> — fetch the page and extract the download link
  const pageMatch = path.match(/^\/skills\/([\w-]+)$/);
  if (pageMatch) {
    const slug = pageMatch[1];
    const res = await fetch(url.toString(), {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) {
      throw new Error(`Failed to load skill page (${res.status} ${res.statusText})`);
    }
    const html = await res.text();
    const m = html.match(/\/api\/skills\/download\/([\w-]+)/);
    if (!m) {
      throw new Error(
        `Could not find a download link on ${url.toString()}. Try pasting the direct download URL instead.`,
      );
    }
    const id = m[1];
    const downloadUrl = new URL(`/api/skills/download/${id}`, url.origin).toString();
    return { downloadUrl, identifier: id, slug };
  }

  throw new Error(
    `Unsupported URL shape: ${url.pathname}. Expected /skills/<slug> or /api/skills/download/<id>.`,
  );
}

async function downloadToTempFile(downloadUrl: string): Promise<{ filePath: string; sha256: string }> {
  const res = await fetch(downloadUrl, {
    redirect: 'follow',
    headers: { Accept: 'application/zip,application/octet-stream' },
  });
  if (!res.ok) {
    throw new Error(`Download failed (${res.status} ${res.statusText})`);
  }

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (contentType && !ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Unexpected content-type: ${contentType} (expected zip)`);
  }

  const declaredLen = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLen) && declaredLen > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `Download too large: ${declaredLen} bytes (max ${MAX_DOWNLOAD_BYTES})`,
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `Download too large: ${buf.byteLength} bytes (max ${MAX_DOWNLOAD_BYTES})`,
    );
  }
  // Zip magic number: PK\x03\x04 (or empty/spanned variants PK\x05\x06, PK\x07\x08)
  if (buf.byteLength < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error('Downloaded file is not a valid zip (bad magic number)');
  }

  const sha256 = createHash('sha256').update(buf).digest('hex');
  const filePath = join(tmpdir(), `coder-skill-${randomBytes(6).toString('hex')}.zip`);
  await writeFile(filePath, buf);
  return { filePath, sha256 };
}

/** Walk the extracted directory and find the directory containing SKILL.md. */
async function findSkillRoot(rootDir: string): Promise<string> {
  const entries = await readdir(rootDir, { recursive: true, withFileTypes: true });
  const skillFiles: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.toLowerCase() !== 'skill.md') continue;
    const parent = (entry as unknown as { parentPath?: string; path?: string }).parentPath
      ?? (entry as unknown as { path?: string }).path
      ?? rootDir;
    skillFiles.push(join(parent, entry.name));
  }
  if (skillFiles.length === 0) {
    throw new Error('No SKILL.md found in the downloaded zip');
  }
  // Pick the shallowest one (so a top-level SKILL.md wins over nested examples).
  skillFiles.sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length);
  return dirname(skillFiles[0]);
}

interface CollectedFile {
  /** Path relative to the skill root, with forward slashes. */
  path: string;
  content: string;
}

async function collectSkillFiles(skillRoot: string): Promise<CollectedFile[]> {
  const entries = await readdir(skillRoot, { recursive: true, withFileTypes: true });
  const out: CollectedFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parent = (entry as unknown as { parentPath?: string; path?: string }).parentPath
      ?? (entry as unknown as { path?: string }).path
      ?? skillRoot;
    const absPath = join(parent, entry.name);
    const rel = absPath.slice(skillRoot.length).replace(/^[\\/]/, '').replace(/\\/g, '/');

    const isSkill = /(^|\/)SKILL\.md$/i.test(rel);
    const isCommand = /(^|\/)commands\/[^/]+\.md$/i.test(rel);
    const isReference = /(^|\/)references\/[^/]+\.md$/i.test(rel);
    const isMcp = rel.toLowerCase() === '.mcp.json';
    if (!isSkill && !isCommand && !isReference && !isMcp) continue;

    const content = await readFile(absPath, 'utf8');
    out.push({ path: rel, content });
  }
  return out;
}

function deriveNamespace(opts: {
  override?: string;
  slug: string | null;
  identifier: string | null;
  skillName?: string;
}): string {
  const candidate =
    opts.override?.trim() ||
    opts.slug ||
    opts.skillName ||
    (opts.identifier ? `mcp-skill-${opts.identifier}` : 'mcp-skill');
  return candidate.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'mcp-skill';
}

export async function installFromUrl(opts: {
  url: string;
  namespace?: string;
  overwrite?: boolean;
}): Promise<InstallResult> {
  const resolved = await resolveDownloadUrl(opts.url);

  let tempZip: string | null = null;
  let tempExtract: string | null = null;
  try {
    const { filePath, sha256 } = await downloadToTempFile(resolved.downloadUrl);
    tempZip = filePath;

    tempExtract = join(tmpdir(), `coder-skill-extract-${randomBytes(6).toString('hex')}`);
    extractZipToDir(tempZip, tempExtract, {
      maxBytes: MAX_EXTRACTED_BYTES,
      clean: true,
    });

    const skillRoot = await findSkillRoot(tempExtract);
    const files = await collectSkillFiles(skillRoot);
    if (files.length === 0) {
      throw new Error('No SKILL.md/commands/references found after extraction');
    }

    // Try to peek the skill name for namespace fallback.
    const skillFile = files.find((f) => /(^|\/)SKILL\.md$/i.test(f.path));
    let parsedSkillName: string | undefined;
    if (skillFile) {
      try {
        const parsed = parseSkillMarkdown(skillFile.content, skillFile.path);
        if (typeof parsed.frontmatter.name === 'string') {
          parsedSkillName = parsed.frontmatter.name;
        }
      } catch {
        // ignore — namespace will fall back to slug/identifier
      }
    }

    const namespace = deriveNamespace({
      override: opts.namespace,
      slug: resolved.slug,
      identifier: resolved.identifier,
      skillName: parsedSkillName,
    });

    const config = loadConfig();
    const dataDir = ensureDataDir();
    const baseDir = join(dataDir, 'skills', namespace);

    if (opts.overwrite) {
      await rm(baseDir, { recursive: true, force: true });
    } else {
      const existing = await stat(baseDir).catch(() => null);
      if (existing) {
        throw new Error(
          `Namespace "${namespace}" already installed. Pass overwrite=true to replace.`,
        );
      }
    }
    await mkdir(baseDir, { recursive: true });

    // Copy collected files to the managed location.
    for (const f of files) {
      const dest = join(baseDir, f.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, f.content, 'utf8');
    }

    // Parse + upsert.
    const commitId = resolved.identifier ?? sha256.slice(0, 12);
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
            `[url-skills-installer] skipping ${f.path}: ${e instanceof Error ? e.message : String(e)}`,
          );
          continue;
        }

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
          source_ref: { repo: opts.url, commit: commitId, path: f.path },
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
      throw new Error(`No valid SKILL.md or command files parsed from ${opts.url}`);
    }

    // .mcp.json registration (mirrors agent-skills-installer.ts).
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
              const cfg = (existing.config ?? {}) as { installed_by_namespace?: string };
              if (cfg.installed_by_namespace !== namespace) {
                warnings.push(
                  `MCP server id "${input.id}" already exists (unmanaged) — skipped`,
                );
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
      repo: opts.url,
      commitSha: commitId,
      baseDir,
      installed,
      mcpServers,
      warnings,
    };
  } finally {
    if (tempZip) await rm(tempZip, { force: true }).catch(() => {});
    if (tempExtract) await rm(tempExtract, { recursive: true, force: true }).catch(() => {});
  }
}
