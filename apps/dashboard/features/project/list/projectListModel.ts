import type { ProjectCardData } from './ProjectCard.js';

export type ProjectListFilter = 'all' | 'notIndexed' | 'indexed';

const projectNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
    .trim();
}

export function matchesProjectSearch(project: ProjectCardData, query: string): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;

  return [
    project.name,
    project.root_path,
    project.description ?? '',
    project.group_name ?? '',
  ].some((value) => normalizeSearchText(value).includes(normalizedQuery));
}

export function matchesProjectFilter(
  project: ProjectCardData,
  filter: ProjectListFilter,
): boolean {
  if (filter === 'all') return true;
  return filter === 'indexed' ? !!project.last_indexed : !project.last_indexed;
}

export function sortProjectsByName(projects: ProjectCardData[]): ProjectCardData[] {
  return [...projects].sort((left, right) =>
    projectNameCollator.compare(left.name, right.name),
  );
}

export function filterProjectList(
  projects: ProjectCardData[],
  query: string,
  filter: ProjectListFilter,
): ProjectCardData[] {
  return sortProjectsByName(
    projects.filter(
      (project) =>
        matchesProjectSearch(project, query) &&
        matchesProjectFilter(project, filter),
    ),
  );
}

export function groupProjectList(
  projects: ProjectCardData[],
): Map<string, ProjectCardData[]> {
  const named = new Map<string, ProjectCardData[]>();
  const ungrouped: ProjectCardData[] = [];

  for (const project of projects) {
    if (!project.group_name) {
      ungrouped.push(project);
      continue;
    }
    const bucket = named.get(project.group_name) ?? [];
    bucket.push(project);
    named.set(project.group_name, bucket);
  }

  const sorted = new Map(
    [...named.entries()]
      .sort(([left], [right]) => projectNameCollator.compare(left, right))
      .map(([group, groupProjects]) => [group, sortProjectsByName(groupProjects)]),
  );

  if (ungrouped.length > 0) {
    sorted.set('__ungrouped__', sortProjectsByName(ungrouped));
  }

  return sorted;
}

export function recentProjectList(
  projects: ProjectCardData[],
  recentIds: number[],
  limit = 4,
): ProjectCardData[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const seen = new Set<number>();
  const recent: ProjectCardData[] = [];

  for (const id of recentIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const project = byId.get(id);
    if (!project) continue;
    recent.push(project);
    if (recent.length >= limit) break;
  }

  return recent;
}

export function countProjectStatuses(projects: ProjectCardData[]): {
  indexed: number;
  notIndexed: number;
} {
  let indexed = 0;
  for (const project of projects) {
    if (project.last_indexed) indexed += 1;
  }
  return { indexed, notIndexed: projects.length - indexed };
}
