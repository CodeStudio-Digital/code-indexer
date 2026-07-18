import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveSftpEdit: vi.fn(),
  getActiveEditor: vi.fn(),
  modelFor: vi.fn(),
  getEffectiveEditorSettings: vi.fn(),
}));

vi.mock('../sftp-edit-session.js', () => ({ saveSftpEdit: mocks.saveSftpEdit }));
vi.mock('../editor-models.js', () => ({
  getActiveEditor: mocks.getActiveEditor,
  modelFor: mocks.modelFor,
}));
vi.mock('../../../../state/editor-settings.js', () => ({
  getEffectiveEditorSettings: mocks.getEffectiveEditorSettings,
}));

import { saveFile } from '../save.js';
import { useWorkspaceStore, type OpenSftpFile } from '../../../../state/workspace.js';

const PATH = 'sftp:test-host:/srv/app/Dockerfile';
const tab: OpenSftpFile = {
  kind: 'sftp',
  projectId: 7,
  path: PATH,
  remotePath: '/srv/app/Dockerfile',
  spec: {
    hostId: 'test-host',
    host: 'example.test',
    username: 'tester',
    auth: { method: 'agent' },
  },
  hostLabel: 'Test host',
  content: 'FROM node:22\n',
  dirty: true,
};

describe('saveFile — SFTP editor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState({
      openFiles: [tab],
      activeProjectId: 7,
      activeFilePath: PATH,
      panes: [{ id: 'test-pane', order: [PATH], activePath: PATH }],
      activePaneId: 'test-pane',
      splitDir: null,
    });
  });

  it('routes Ctrl+S/save to the registered remote upload instead of files.write', async () => {
    mocks.saveSftpEdit.mockResolvedValue(true);

    await expect(saveFile(7, PATH)).resolves.toBe(true);

    expect(mocks.saveSftpEdit).toHaveBeenCalledWith(7, PATH);
  });

  it('keeps a failed remote upload reported as an unsuccessful save', async () => {
    mocks.saveSftpEdit.mockResolvedValue(false);

    await expect(saveFile(7, PATH)).resolves.toBe(false);
  });
});
