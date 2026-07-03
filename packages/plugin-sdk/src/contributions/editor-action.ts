import type { ContributedEditorAction } from './types.js';

/** Declare an editor/project action exposed through the host command system. */
export function contributeEditorAction(action: ContributedEditorAction): ContributedEditorAction {
  return action;
}
