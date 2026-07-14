import { describe, expect, it } from 'vitest';
import {
  LEFT_TOOL_TABS,
  API_RIGHT_TOOL,
  PRIMARY_SURFACES,
  RIGHT_TOOL_TABS,
  projectSurface,
  projectSurfacesFor,
  projectToolAvailableInContext,
} from '../tabs-config.js';

describe('project workbench surface registry', () => {
  it('routes built-ins to their professional workbench side', () => {
    expect(LEFT_TOOL_TABS.map((tab) => tab.id)).toEqual(['files', 'git', 'sessions', 'api-navigation', 'databases']);
    expect(LEFT_TOOL_TABS.filter((tab) => tab.separatorBefore).map((tab) => tab.id)).toEqual(['sessions']);
    expect(RIGHT_TOOL_TABS.map((tab) => tab.id)).toEqual(['chat', 'snapshots', 'memory']);
    expect(PRIMARY_SURFACES.map((tab) => tab.id)).toEqual([
      'editor', 'sessions', 'api', 'ssh', 'diagrams', 'index', 'preview',
    ]);
  });

  it('offers a single lookup and side filter for deep links and pins', () => {
    expect(projectSurface('git')?.kind).toBe('left');
    expect(projectSurface('chat')?.kind).toBe('right');
    expect(projectSurface('api')?.kind).toBe('primary');
    expect(projectSurface('api-navigation')?.kind).toBe('left');
    expect(projectSurface('api-inspector')).toEqual(API_RIGHT_TOOL);
    expect(projectSurfacesFor('left')).toEqual(LEFT_TOOL_TABS);
  });

  it('rejects API-owned docks outside the API surface', () => {
    expect(projectToolAvailableInContext('api-navigation', 'api')).toBe(true);
    expect(projectToolAvailableInContext('api-inspector', 'api')).toBe(true);
    expect(projectToolAvailableInContext('api-navigation', 'editor')).toBe(false);
    expect(projectToolAvailableInContext('api-inspector', 'editor')).toBe(false);
    expect(projectToolAvailableInContext('files', 'api')).toBe(true);
    expect(projectToolAvailableInContext('memory', 'editor')).toBe(true);
  });
});
