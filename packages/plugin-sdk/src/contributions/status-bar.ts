import type { ContributedStatusBarItem } from './types.js';

/** Declare an IDE status-bar item contributed by a plugin. */
export function contributeStatusBarItem(item: ContributedStatusBarItem): ContributedStatusBarItem {
  return item;
}
