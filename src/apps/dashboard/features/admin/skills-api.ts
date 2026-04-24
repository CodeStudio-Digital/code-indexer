export type SkillContextMode = 'inline' | 'tool' | 'both';
export type SkillSource = 'user' | 'builtin' | 'imported';

export interface AdminSkill {
  id: string;
  name: string;
  description: string;
  slash_command: string | null;
  prompt_body: string;
  scope: string;
  enabled: boolean;
  allowed_tools: string[] | null;
  model_override: string | null;
  provider_override: string | null;
  context_mode: SkillContextMode;
  variables: string[];
  sort_order: number;
  tags: string[];
  path_patterns: string[] | null;
  author: string | null;
  version: string;
  source: SkillSource;
  created_at: string;
  updated_at: string;
}

export interface SkillUsageStats {
  total_invocations: number;
  last_used: string | null;
}

export async function fetchSkills(): Promise<AdminSkill[]> {
  const r = await fetch('/api/admin/skills');
  const j = (await r.json()) as { skills: AdminSkill[] };
  return j.skills;
}

export async function saveSkill(
  s: Partial<AdminSkill>,
  isExisting: boolean,
): Promise<void> {
  const method = isExisting ? 'PATCH' : 'POST';
  const url = isExisting ? `/api/admin/skills/${s.id}` : '/api/admin/skills';
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s),
  });
  if (!r.ok) {
    const err = (await r.json()) as { error: string };
    throw new Error(err.error);
  }
}

export async function deleteSkill(id: string): Promise<void> {
  await fetch(`/api/admin/skills/${id}`, { method: 'DELETE' });
}

export async function duplicateSkill(id: string): Promise<AdminSkill> {
  const r = await fetch(`/api/admin/skills/${id}/duplicate`, { method: 'POST' });
  return (await r.json()) as AdminSkill;
}

export async function exportSkill(id: string): Promise<Record<string, unknown>> {
  const r = await fetch(`/api/admin/skills/${id}/export`);
  return (await r.json()) as Record<string, unknown>;
}

export async function importSkill(
  skill: Record<string, unknown>,
  overwrite = false,
): Promise<void> {
  const r = await fetch('/api/admin/skills/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skill, overwrite }),
  });
  if (!r.ok) {
    const err = (await r.json()) as { error: string };
    throw new Error(err.error);
  }
}

// ─── Agent Skills (third-party install) ──────────────────────────

export interface InstalledNamespace {
  namespace: string;
  repo: string | null;
  commit: string | null;
  skillCount: number;
  commandCount: number;
  mcpCount: number;
}

export interface InstalledMcpServer {
  id: string;
  name: string;
  transport: string;
}

export interface InstallFromGithubResult {
  namespace: string;
  repo: string;
  commitSha: string;
  baseDir: string;
  installed: Array<{
    id: string;
    name: string;
    kind: 'skill' | 'command';
    slash_command: string | null;
  }>;
  mcpServers?: InstalledMcpServer[];
  warnings?: string[];
}

export async function installSkillFromGithub(opts: {
  repo: string;
  namespace?: string;
  ref?: string;
  overwrite?: boolean;
}): Promise<InstallFromGithubResult> {
  const r = await fetch('/api/admin/skills/install-github', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  const j = (await r.json()) as InstallFromGithubResult | { error: string };
  if (!r.ok) throw new Error((j as { error: string }).error);
  return j as InstallFromGithubResult;
}

export async function listSkillNamespaces(): Promise<InstalledNamespace[]> {
  const r = await fetch('/api/admin/skills/namespaces');
  const j = (await r.json()) as { namespaces: InstalledNamespace[] };
  return j.namespaces;
}

export async function updateSkillNamespace(
  namespace: string,
  ref?: string,
): Promise<InstallFromGithubResult> {
  const r = await fetch(
    `/api/admin/skills/namespace/${encodeURIComponent(namespace)}/update`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref }),
    },
  );
  const j = (await r.json()) as InstallFromGithubResult | { error: string };
  if (!r.ok) throw new Error((j as { error: string }).error);
  return j as InstallFromGithubResult;
}

export async function uninstallSkillNamespace(
  namespace: string,
): Promise<{ namespace: string; removed: number }> {
  const r = await fetch(
    `/api/admin/skills/namespace/${encodeURIComponent(namespace)}`,
    { method: 'DELETE' },
  );
  const j = (await r.json()) as { namespace: string; removed: number } | { error: string };
  if (!r.ok) throw new Error((j as { error: string }).error);
  return j as { namespace: string; removed: number };
}

export async function installSkillFromLocal(opts: {
  folderPath: string;
  namespace?: string;
  overwrite?: boolean;
}): Promise<InstallFromGithubResult> {
  const r = await fetch('/api/admin/skills/install-local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  const j = (await r.json()) as InstallFromGithubResult | { error: string };
  if (!r.ok) throw new Error((j as { error: string }).error);
  return j as InstallFromGithubResult;
}

export async function fetchSkillUsage(id: string): Promise<SkillUsageStats> {
  const r = await fetch(`/api/admin/skills/${id}/usage`);
  return (await r.json()) as SkillUsageStats;
}
