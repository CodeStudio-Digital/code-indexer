/** Git checkouts available to the project's session workbench. */
export interface CoderWorktree {
  path: string;
  branch: string | null;
  head: string;
  primary: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface CoderWorktrees {
  isGit: boolean;
  worktrees: CoderWorktree[];
}
