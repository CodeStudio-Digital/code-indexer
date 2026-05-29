import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fetchRepoSkillFiles } from '@mcp/code-agent/skills/github-fetcher.js';
import type { MaterializeResult } from './index.js';

/** Manifests the skill fetcher does not grab — pulled separately by commit. */
const EXTRA_FILES = ['plugin.json', '.app.json'];

/** Fetch a plugin repo's skill/mcp files + manifests into staging. */
export async function materializeGithub(
  repo: string,
  ref: string | undefined,
  stagingDir: string,
): Promise<MaterializeResult> {
  const { files, commitSha } = await fetchRepoSkillFiles({
    repo,
    ref,
    token: process.env.CODER_GITHUB_TOKEN,
  });

  await mkdir(stagingDir, { recursive: true });
  for (const f of files) {
    const dest = join(stagingDir, f.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, f.content, 'utf8');
  }

  // fetchRepoSkillFiles only grabs SKILL.md / commands / references / .mcp.json.
  for (const name of EXTRA_FILES) {
    const content = await fetchRaw(repo, commitSha, name);
    if (content !== null) await writeFile(join(stagingDir, name), content, 'utf8');
  }

  return { ref: commitSha };
}

async function fetchRaw(repo: string, sha: string, path: string): Promise<string | null> {
  const token = process.env.CODER_GITHUB_TOKEN;
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`raw fetch ${res.status} for ${path}`);
  return res.text();
}
