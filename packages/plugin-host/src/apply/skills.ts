import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import {
  parseSkillMarkdown,
  toSkillDefinition,
} from '@mcp/code-agent/skills/agent-skills-parser.js';
import { SkillStore } from '@mcp/store/skill-store.js';
import type { SkillSourceRef } from '@mcp/store/skill-store.js';
import type { InstalledSkillSummary } from '../types.js';

const norm = (p: string): string => p.split('\\').join('/');

async function listRelFiles(baseDir: string): Promise<string[]> {
  const entries = await readdir(baseDir, { recursive: true });
  return entries.map(norm);
}

function findRefs(rels: string[], skillDir: string, baseDir: string): string[] {
  const prefix = skillDir ? `${skillDir}/references/` : 'references/';
  return rels.filter((r) => r.startsWith(prefix)).map((r) => join(baseDir, r));
}

/** Parse SKILL.md + commands/*.md under `baseDir` and upsert into SkillStore. */
export async function applySkills(opts: {
  dbPath: string;
  baseDir: string;
  namespace: string;
  repo: string | null;
  commit: string | null;
}): Promise<{ installed: InstalledSkillSummary[]; warnings: string[] }> {
  const { dbPath, baseDir, namespace, repo, commit } = opts;
  const rels = await listRelFiles(baseDir);
  const store = new SkillStore(dbPath);
  const installed: InstalledSkillSummary[] = [];
  const warnings: string[] = [];
  try {
    for (const rel of rels) {
      const isSkill = /(^|\/)SKILL\.md$/i.test(rel);
      const isCommand = /(^|\/)commands\/[^/]+\.md$/i.test(rel);
      if (!isSkill && !isCommand) continue;

      let content: string;
      try {
        content = await readFile(join(baseDir, rel), 'utf8');
      } catch {
        continue; // matched a directory name — skip
      }

      let parsed;
      try {
        parsed = parseSkillMarkdown(content, rel);
      } catch (e) {
        warnings.push(`skip ${rel}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }

      const dir = isSkill ? dirname(rel) : '';
      const skillDir = dir === '.' ? '' : dir;
      const referenceFiles = isSkill ? findRefs(rels, skillDir, baseDir) : [];
      const input = toSkillDefinition({
        parsed,
        namespace,
        extractedBaseDir: baseDir,
        referenceFiles,
      });
      const sourceRef: SkillSourceRef | undefined =
        repo && commit ? { repo, commit, path: rel } : undefined;
      const stored = store.upsertSkill(
        sourceRef ? { ...input, source_ref: sourceRef } : input,
      );
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
  return { installed, warnings };
}
