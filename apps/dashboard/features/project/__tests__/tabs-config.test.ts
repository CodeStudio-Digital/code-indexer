import { describe, expect, it } from 'vitest';
import {
  LEFT_TOOL_TABS,
  API_RIGHT_TOOL,
  PRIMARY_SURFACES,
  PROJECT_RAIL_TABS,
  RIGHT_TOOL_TABS,
  WORKSPACE_SURFACES,
  projectSurface,
  projectSurfacesFor,
} from '../tabs-config.js';

describe('project workbench surface registry', () => {
  it('routes built-ins to their professional workbench side', () => {
    expect(LEFT_TOOL_TABS.map((tab) => tab.id)).toEqual(['files', 'git', 'databases']);
    expect(RIGHT_TOOL_TABS.map((tab) => tab.id)).toEqual(['chat', 'memory']);
    expect(PRIMARY_SURFACES.map((tab) => tab.id)).toEqual([
      'editor', 'sessions', 'api', 'ssh', 'diagrams', 'snapshots', 'index', 'preview',
    ]);
    expect(WORKSPACE_SURFACES.map((tab) => tab.id)).toEqual([
      'sessions', 'api', 'ssh', 'diagrams', 'snapshots', 'index', 'preview',
    ]);
    expect(WORKSPACE_SURFACES.filter((tab) => tab.separatorBefore).map((tab) => tab.id)).toEqual(['sessions']);
    expect(PROJECT_RAIL_TABS.map((tab) => tab.id)).toEqual([
      'sessions', 'files', 'git', 'databases', 'api', 'ssh', 'diagrams', 'snapshots', 'index', 'preview',
    ]);
    expect(PROJECT_RAIL_TABS.filter((tab) => tab.separatorBefore).map((tab) => tab.id)).toEqual(['api']);
  });

  it('offers a single lookup and side filter for deep links and pins', () => {
    expect(projectSurface('git')?.kind).toBe('left');
    expect(projectSurface('chat')?.kind).toBe('right');
    expect(projectSurface('api')?.kind).toBe('primary');
    expect(projectSurface('sessions')?.kind).toBe('primary');
    expect(projectSurface('snapshots')?.kind).toBe('primary');
    expect(projectSurface('api-inspector')).toEqual(API_RIGHT_TOOL);
    expect(projectSurfacesFor('left')).toEqual(LEFT_TOOL_TABS);
  });

  it('keeps every rail and primary id unique', () => {
    const ids = [...LEFT_TOOL_TABS, ...PRIMARY_SURFACES, ...RIGHT_TOOL_TABS, API_RIGHT_TOOL].map((tab) => tab.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
