/** Git checkouts available to the project's session workbench. */
export interface CoderWorktree {
  path: string;
  branch: string | null;
  head: string;
  primary: boolean;
  /** The repository's main checkout, which may differ from the opened project. */
  repositoryMain?: boolean;
  /** A chat binding whose checkout is no longer registered in Git. */
  historyOnly?: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface CoderWorktrees {
  isGit: boolean;
  worktrees: CoderWorktree[];
}

export interface CoderWorktreeRemoval {
  removed: true;
  branchDeleted: boolean;
  branchWarning?: string;
}
