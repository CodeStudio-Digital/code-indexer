import { describe, expect, it } from 'vitest';
import type { ProjectCardData } from '../ProjectCard.js';
import {
  countProjectStatuses,
  filterProjectList,
  groupProjectList,
  matchesProjectSearch,
  recentProjectList,
} from '../projectListModel.js';

const projects: ProjectCardData[] = [
  {
    id: 1,
    name: 'Protoview Clínico',
    root_path: 'F:\\HapVida\\Protoview',
    description: 'Portal clínico',
    group_name: 'HapVida',
    file_count: 10,
    symbol_count: 20,
    last_indexed: null,
  },
  {
    id: 2,
    name: 'poa-backend',
    root_path: 'D:\\poa-monorepo\\backend',
    description: null,
    group_name: 'POA',
    file_count: 30,
    symbol_count: 40,
    last_indexed: '2026-07-30T12:00:00.000Z',
  },
  {
    id: 3,
    name: 'angular-sandbox',
    root_path: 'D:\\scratch\\angular',
    group_name: null,
    file_count: 5,
    symbol_count: 8,
    last_indexed: null,
  },
];

describe('project list model', () => {
  it('searches name, path, description and group without requiring accents', () => {
    expect(matchesProjectSearch(projects[0], 'clinico')).toBe(true);
    expect(matchesProjectSearch(projects[0], 'portal clinico')).toBe(true);
    expect(matchesProjectSearch(projects[1], 'poa-monorepo')).toBe(true);
    expect(matchesProjectSearch(projects[2], 'hapvida')).toBe(false);
  });

  it('combines search and index-state filters and sorts results by name', () => {
    expect(filterProjectList(projects, '', 'notIndexed').map((project) => project.id)).toEqual([
      3,
      1,
    ]);
    expect(filterProjectList(projects, 'poa', 'indexed').map((project) => project.id)).toEqual([
      2,
    ]);
    expect(filterProjectList(projects, 'poa', 'notIndexed')).toEqual([]);
  });

  it('sorts named groups and keeps the ungrouped bucket last', () => {
    const grouped = groupProjectList(projects);
    expect([...grouped.keys()]).toEqual(['HapVida', 'POA', '__ungrouped__']);
    expect(grouped.get('__ungrouped__')?.map((project) => project.id)).toEqual([3]);
  });

  it('preserves MRU order, ignores stale ids and deduplicates entries', () => {
    expect(recentProjectList(projects, [2, 999, 1, 2, 3], 2).map((project) => project.id)).toEqual([
      2,
      1,
    ]);
  });

  it('counts indexed and non-indexed projects from the actual timestamp', () => {
    expect(countProjectStatuses(projects)).toEqual({ indexed: 1, notIndexed: 2 });
  });
});
