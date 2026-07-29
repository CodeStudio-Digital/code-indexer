import { create } from 'zustand';

interface PushRequestBase {
  id: number;
  onPushed?: () => void | Promise<void>;
}

export interface ProjectPushRequest extends PushRequestBase {
  kind: 'project';
  projectId: number;
  repoPath?: string;
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
  force?: boolean;
}

export interface WorkspacePushRequest extends PushRequestBase {
  kind: 'workspace';
  sessionId: string;
  projectId: number;
}

export type PushDialogRequest = ProjectPushRequest | WorkspacePushRequest;
type NewProjectRequest = Omit<ProjectPushRequest, 'id' | 'kind'>;
type NewWorkspaceRequest = Omit<WorkspacePushRequest, 'id' | 'kind'>;

interface PushDialogState {
  request: PushDialogRequest | null;
  open: (request: PushDialogRequest) => void;
  close: (id?: number) => void;
}

let nextRequestId = 1;

export const usePushDialogStore = create<PushDialogState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: (id) => set((state) => (
    id !== undefined && state.request?.id !== id ? state : { request: null }
  )),
}));

export function openProjectPushDialog(request: NewProjectRequest): void {
  usePushDialogStore.getState().open({ ...request, kind: 'project', id: nextRequestId++ });
}

export function openWorkspacePushDialog(request: NewWorkspaceRequest): void {
  usePushDialogStore.getState().open({ ...request, kind: 'workspace', id: nextRequestId++ });
}

export function closePushDialog(id?: number): void {
  usePushDialogStore.getState().close(id);
}
