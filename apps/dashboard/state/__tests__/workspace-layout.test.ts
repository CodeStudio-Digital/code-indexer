import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT_NAVIGATION,
  DEFAULT_WORKSPACE_LAYOUT,
  migrateWorkspaceLayoutV2,
  normalizeWorkspaceLayout,
  normalizeProjectNavigation,
  projectNavigationStorageKey,
  useWorkspaceLayout,
} from '../workspace-layout.js';

function installStorage(): Map<string, string> {
  const values = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  };
  return values;
}

describe('workspace layout v3', () => {
  it('opens an IDE-first layout for a new user', () => {
    expect(migrateWorkspaceLayoutV2(null)).toEqual({
      activeLeft: 'files',
      activeRight: 'chat',
      activeBottom: null,
      primarySurface: 'editor',
      previewVisible: true,
    });
  });

  it('migrates v2 visibility and drops unused pixel dimensions', () => {
    expect(migrateWorkspaceLayoutV2({
      activeLeft: 'git',
      activeRight: null,
      activeBottom: 'problems',
      previewVisible: false,
      leftSize: 420,
      rightSize: 510,
      bottomSize: 300,
    })).toEqual({
      activeLeft: 'git',
      activeRight: null,
      activeBottom: 'problems',
      primarySurface: 'editor',
      previewVisible: false,
    });
  });

  it('preserves explicit collapsed sides while filling missing fields', () => {
    expect(normalizeWorkspaceLayout({ activeLeft: null, activeRight: null })).toEqual({
      ...DEFAULT_WORKSPACE_LAYOUT,
      activeLeft: null,
      activeRight: null,
    });
  });

  it('migrates the old dedicated database surface into the left tool window', () => {
    expect(normalizeWorkspaceLayout({ primarySurface: 'databases', activeLeft: 'files' })).toMatchObject({
      primarySurface: 'editor',
      activeLeft: 'databases',
    });
  });

  it('migrates contextual Session and API docks into isolated workspaces', () => {
    expect(normalizeWorkspaceLayout({ primarySurface: 'editor', activeLeft: 'sessions', activeRight: null })).toMatchObject({
      primarySurface: 'sessions',
      activeLeft: 'files',
      activeRight: null,
    });
    expect(normalizeWorkspaceLayout({ primarySurface: 'editor', activeLeft: 'api-navigation', activeRight: 'api-inspector' })).toMatchObject({
      primarySurface: 'api',
      activeLeft: 'files',
      activeRight: 'chat',
    });
  });

  it('does not persist API-owned docks as Code workspace state', () => {
    expect(normalizeWorkspaceLayout({ primarySurface: 'api', activeLeft: 'files', activeRight: 'api-inspector' })).toMatchObject({
      primarySurface: 'api',
      activeLeft: 'files',
      activeRight: 'chat',
    });
  });

  it('promotes the former Snapshots right dock into its dedicated workspace', () => {
    expect(normalizeWorkspaceLayout({
      primarySurface: 'editor',
      activeLeft: 'files',
      activeRight: 'snapshots',
    })).toMatchObject({
      primarySurface: 'snapshots',
      activeLeft: 'files',
      activeRight: 'chat',
    });
  });

  it('does not replace another active workspace with a stale Snapshots dock', () => {
    expect(normalizeWorkspaceLayout({
      primarySurface: 'sessions',
      activeLeft: 'files',
      activeRight: 'snapshots',
    })).toMatchObject({
      primarySurface: 'sessions',
      activeRight: 'chat',
    });
  });
});

describe('project-scoped rail navigation', () => {
  beforeEach(() => installStorage());
  afterEach(() => {
    useWorkspaceLayout.getState().deactivateProject(101);
    useWorkspaceLayout.getState().deactivateProject(202);
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('uses Session when a project has no remembered navigation', () => {
    expect(normalizeProjectNavigation(null)).toEqual(DEFAULT_PROJECT_NAVIGATION);
    useWorkspaceLayout.getState().activateProject(101);
    expect(useWorkspaceLayout.getState()).toMatchObject({
      activeLeft: 'files',
      primarySurface: 'sessions',
    });
  });

  it('restores each project independently', () => {
    const layout = useWorkspaceLayout.getState();
    layout.activateProject(101);
    layout.setPrimarySurface('editor');
    layout.setActiveLeft('git');

    layout.activateProject(202);
    expect(useWorkspaceLayout.getState()).toMatchObject(DEFAULT_PROJECT_NAVIGATION);
    useWorkspaceLayout.getState().setPrimarySurface('api');

    useWorkspaceLayout.getState().activateProject(101);
    expect(useWorkspaceLayout.getState()).toMatchObject({ activeLeft: 'git', primarySurface: 'editor' });
    expect(window.localStorage.getItem(projectNavigationStorageKey(202))).toContain('"primarySurface":"api"');
  });
});
