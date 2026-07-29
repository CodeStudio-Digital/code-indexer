import { minimatch } from 'minimatch';
import type { SessionId } from '@mcp/session-storage';
import type {
  PreflightMemoryEntry,
  PreflightSkillMeta,
  PreflightToolMeta,
  PreflightWorkspaceProject,
} from './preflight-prompt.js';

interface PreflightCatalogDeps {
  getToolCatalog: () => PreflightToolMeta[];
  getMemoryIndex: (projectId: number) => PreflightMemoryEntry[];
  getSkillCatalog?: (
    sessionId: SessionId,
    projectId: number,
    projectRoot?: string,
    activeSkillIds?: readonly string[] | null,
  ) => PreflightSkillMeta[];
}

interface PreflightCatalogInput {
  sessionId: SessionId;
  projectId?: number | null;
  userMessage: string;
  isGlobalWorkspace?: boolean;
  workspaceProjects?: PreflightWorkspaceProject[];
  activeSkillIds?: readonly string[] | null;
}

export interface PreparedPreflightCatalogs {
  toolCatalog: PreflightToolMeta[];
  memoryIndex: PreflightMemoryEntry[];
  skillCatalog: PreflightSkillMeta[];
  workspaceProjects: PreflightWorkspaceProject[];
}

function stableHash(value: string): string {
  let h = 5381;
  for (let i = 0; i < value.length; i++) h = (((h << 5) + h) + value.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function normalizedText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function mentionsLiteral(message: string, value: string): boolean {
  const target = normalizedText(value);
  if (!target) return false;
  let from = 0;
  while (from <= message.length - target.length) {
    const index = message.indexOf(target, from);
    if (index < 0) return false;
    const left = index > 0 ? message[index - 1]! : '';
    const rightIndex = index + target.length;
    const right = rightIndex < message.length ? message[rightIndex]! : '';
    if (!/[\p{L}\p{N}_]/u.test(left) && !/[\p{L}\p{N}_]/u.test(right)) return true;
    from = index + 1;
  }
  return false;
}

function triggerMatches(skill: PreflightSkillMeta, message: string): boolean {
  const lower = normalizedText(message);
  if (skill.triggerRoles?.some((role) => mentionsLiteral(lower, role))) return true;
  if (skill.triggerTags?.some((tag) => mentionsLiteral(lower, tag))) return true;
  const paths = message
    .split(/\s+/)
    .map((token) => token.replace(/^[`'"(<\[]+|[`'">)\],.;:]+$/g, '').replace(/\\/g, '/'))
    .filter((token) => token.includes('/') || /\.[a-z0-9]{1,8}$/i.test(token));
  return !!skill.triggerPaths?.some((pattern) =>
    paths.some((path) => minimatch(path, pattern, { matchBase: true })),
  );
}

export function preparePreflightCatalogs(
  deps: PreflightCatalogDeps,
  input: PreflightCatalogInput,
): PreparedPreflightCatalogs {
  const workspaceProjects = input.workspaceProjects ?? [];
  const toolCatalog = deps.getToolCatalog().filter((tool) =>
    !input.isGlobalWorkspace || !tool.name.startsWith('git_'),
  );
  const memoryIndex = input.isGlobalWorkspace
    ? workspaceProjects.flatMap((project) =>
        deps.getMemoryIndex(project.projectId).map((memory) => ({ ...memory, projectSlug: project.slug })),
      )
    : input.projectId != null ? deps.getMemoryIndex(input.projectId) : [];

  const merged = new Map<string, PreflightSkillMeta & {
    projectSlugSet: Set<string>;
    dependencySlugSet: Set<string>;
  }>();
  if (deps.getSkillCatalog) {
    const projects = workspaceProjects.length > 0
      ? workspaceProjects
      : input.projectId != null
        ? [{ projectId: input.projectId, name: '', slug: '', rootPath: '', isPrimary: true }]
        : [];
    for (const project of projects) {
      for (const skill of deps.getSkillCatalog(
        input.sessionId,
        project.projectId,
        project.rootPath || undefined,
        input.activeSkillIds,
      )) {
        const current = merged.get(skill.id) ?? {
          ...skill,
          projectSlugSet: new Set<string>(),
          dependencySlugSet: new Set<string>(),
        };
        if (skill.scope && skill.scope !== 'global' && project.slug) current.projectSlugSet.add(project.slug);
        if (skill.dependencyMatched && project.slug) current.dependencySlugSet.add(project.slug);
        current.dependencyMatched ||= skill.dependencyMatched;
        current.triggerPaths = [...new Set([...(current.triggerPaths ?? []), ...(skill.triggerPaths ?? [])])];
        current.triggerRoles = [...new Set([...(current.triggerRoles ?? []), ...(skill.triggerRoles ?? [])])];
        current.triggerTags = [...new Set([...(current.triggerTags ?? []), ...(skill.triggerTags ?? [])])];
        current.packageNames = [...new Set([...(current.packageNames ?? []), ...(skill.packageNames ?? [])])];
        merged.set(skill.id, current);
      }
    }
  }

  const lower = normalizedText(input.userMessage);
  const skillCatalog: PreflightSkillMeta[] = [];
  for (const skill of merged.values()) {
    const explicit =
      mentionsLiteral(lower, skill.id) ||
      (!!skill.name && mentionsLiteral(lower, skill.name)) ||
      !!skill.packageNames?.some((name) => mentionsLiteral(lower, name));
    const projectScoped = !!skill.scope && skill.scope !== 'global';
    const dependency = skill.dependencySlugSet.size > 0;
    const evidence = explicit
      ? 'explicit'
      : triggerMatches(skill, input.userMessage)
        ? 'trigger'
        : dependency
          ? 'dependency'
          : projectScoped
            ? 'project_scope'
            : undefined;
    if (!evidence) continue;
    const projectSlugs = projectScoped
      ? [...skill.projectSlugSet]
      : dependency
        ? [...skill.dependencySlugSet]
        : undefined;
    const { projectSlugSet: _projectSlugSet, dependencySlugSet: _dependencySlugSet, ...meta } = skill;
    skillCatalog.push({ ...meta, evidence, ...(projectSlugs?.length ? { projectSlugs } : {}) });
  }

  return { toolCatalog, memoryIndex, skillCatalog, workspaceProjects };
}

export function preflightCapabilityFingerprint(prepared: PreparedPreflightCatalogs): string {
  return stableHash(JSON.stringify({
    projects: prepared.workspaceProjects.map((p) => [p.projectId, p.slug, p.isPrimary]),
    tools: prepared.toolCatalog.map((t) => [t.name, t.tier, t.description ?? '']),
    skills: prepared.skillCatalog.map((s) => [
      s.id,
      s.name ?? '',
      s.description ?? '',
      s.scope ?? '',
      s.evidence,
      s.projectSlugs ?? [],
    ]),
  }));
}
