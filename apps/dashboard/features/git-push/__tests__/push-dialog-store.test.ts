import { afterEach, describe, expect, it } from 'vitest';
import {
  closePushDialog,
  openProjectPushDialog,
  openWorkspacePushDialog,
  usePushDialogStore,
} from '../push-dialog-store.js';

afterEach(() => closePushDialog());

describe('push dialog store', () => {
  it('replaces an older request and ignores a stale close', () => {
    openProjectPushDialog({ projectId: 1, repoPath: 'nested' });
    const first = usePushDialogStore.getState().request!;
    openWorkspacePushDialog({ sessionId: 2, projectId: 3 });
    const second = usePushDialogStore.getState().request!;

    expect(first).toMatchObject({ kind: 'project', projectId: 1, repoPath: 'nested' });
    expect(second).toMatchObject({ kind: 'workspace', sessionId: 2, projectId: 3 });
    closePushDialog(first.id);
    expect(usePushDialogStore.getState().request?.id).toBe(second.id);
    closePushDialog(second.id);
    expect(usePushDialogStore.getState().request).toBeNull();
  });
});
