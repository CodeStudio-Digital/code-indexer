import type { ContributedToolWindow } from './types.js';

/** Declare an IDE tool window rendered as a sandboxed iframe webview. */
export function contributeToolWindow(window: ContributedToolWindow): ContributedToolWindow {
  return window;
}
