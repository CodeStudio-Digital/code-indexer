import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const railCapture = vi.hoisted(() => ({
  onToggleBottom: null as null | (() => void),
}));
const layoutState = vi.hoisted(() => {
  const state = {
    activeLeft: 'files' as string | null,
    activeRight: 'chat' as string | null,
    activeBottom: null as string | null,
    primarySurface: 'editor',
    previewVisible: true,
    setActiveLeft: (value: string | null) => { state.activeLeft = value; },
    setActiveRight: (value: string | null) => { state.activeRight = value; },
    setActiveBottom: (value: string | null) => { state.activeBottom = value; },
    setPrimarySurface: (value: string) => { state.primarySurface = value; },
    toggleLeft: (value: string) => { state.activeLeft = state.activeLeft === value ? null : value; },
    toggleRight: (value: string) => { state.activeRight = state.activeRight === value ? null : value; },
    toggleBottom: (value: string) => { state.activeBottom = state.activeBottom === value ? null : value; },
  };
  return state;
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-resizable-panels', () => ({
  PanelGroup: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Panel: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('../../../state/workspace-layout.js', () => {
  const useWorkspaceLayout = Object.assign(
    () => layoutState,
    {
      getState: () => layoutState,
      setState: (patch: Partial<typeof layoutState>) => Object.assign(layoutState, patch),
    },
  );
  return { useWorkspaceLayout };
});

vi.mock('../../../components/workbench/index.js', () => ({
  WorkbenchPanelHeader: () => null,
  WorkbenchResizeHandle: () => createElement('div'),
  WorkbenchShell: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  WorkbenchSurface: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('../../workspace/file-tree/FileTreeView.js', () => ({ FileTreeView: () => null }));
vi.mock('../../workspace/jetbrains/tool-windows/GitWindow.js', () => ({ GitWindow: () => null }));
vi.mock('../../workspace/jetbrains/tool-windows/WebviewWindow.js', () => ({ WebviewWindow: () => null }));
vi.mock('../../workspace/jetbrains/StatusBar.js', () => ({ StatusBar: () => null }));
vi.mock('../editor-chat/EditorChatRail.js', () => ({ EditorChatRail: () => null }));
vi.mock('../tabs/TransientSurface.js', () => ({ TransientSurface: () => null }));
vi.mock('../ProjectPrimarySurface.js', () => ({ ProjectPrimarySurface: () => null }));
vi.mock('../ProjectRightRail.js', () => ({ ProjectRightRail: () => null }));
vi.mock('../../db-client/DatabaseToolWindow.js', () => ({ DatabaseToolWindow: () => null }));
vi.mock('../ProjectRail.js', () => ({
  ProjectRail: (props: { bottomOpen: boolean; onToggleBottom: () => void }) => {
    railCapture.onToggleBottom = props.onToggleBottom;
    return createElement('div', { 'data-bottom-open': String(props.bottomOpen) });
  },
}));
vi.mock('../../workspace/BottomPanel.js', () => ({
  BOTTOM_BUILTIN_TAB_IDS: new Set(['terminal', 'runners', 'problems', 'output', 'find']),
  BottomPanel: () => createElement('div', { 'data-testid': 'project-bottom-panel' }),
}));

import { useWorkspaceLayout } from '../../../state/workspace-layout.js';
import { ProjectWorkbench } from '../ProjectWorkbench.js';

const PRIMARY_SURFACES = [
  'editor',
  'sessions',
  'api',
  'ssh',
  'diagrams',
  'snapshots',
  'index',
  'preview',
];

function renderWorkbench(): string {
  return renderToStaticMarkup(createElement(ProjectWorkbench, {
    projectId: 42,
    projectName: 'Bottom panel project',
    projectRoot: 'D:\\project',
    activeFilePath: null,
    onOpenFile: () => undefined,
    contribWindows: [],
    builderJson: null,
    previewEnabled: true,
  }));
}

describe('ProjectWorkbench bottom panel ownership', () => {
  beforeEach(() => {
    railCapture.onToggleBottom = null;
    useWorkspaceLayout.setState({
      activeLeft: 'files',
      activeRight: 'chat',
      activeBottom: 'terminal',
      primarySurface: 'editor',
      previewVisible: true,
    });
  });

  it.each(PRIMARY_SURFACES)('keeps the bottom panel mounted on the %s surface', (primarySurface) => {
    useWorkspaceLayout.setState({ primarySurface, activeBottom: 'terminal' });

    const html = renderWorkbench();

    expect(html).toContain('data-testid="project-bottom-panel"');
    expect(html).toContain('data-bottom-open="true"');
  });

  it('toggles the bottom panel without replacing the current project surface', () => {
    useWorkspaceLayout.setState({ primarySurface: 'sessions', activeBottom: null });
    renderWorkbench();

    expect(railCapture.onToggleBottom).not.toBeNull();
    railCapture.onToggleBottom?.();

    expect(useWorkspaceLayout.getState().primarySurface).toBe('sessions');
    expect(useWorkspaceLayout.getState().activeBottom).toBe('terminal');
  });
});
