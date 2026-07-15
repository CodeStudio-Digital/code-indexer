import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  migrateWorkspaceLayoutV2,
  normalizeWorkspaceLayout,
} from '../workspace-layout.js';

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
