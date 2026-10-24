import type { ToolEffectBoundaryKind, ToolMutationEffect, ToolMutationFence } from './tool.js';
export interface MutationFenceSnapshot {
  environmentId: string;
  environmentVersion: number;
  workspaceLeaseId?: string;
  workspaceLeaseVersion?: number;
  workspaceFencingEpoch?: number;
  ownerAgentRunId?: string;
}


export interface MutationFenceAuthorityOptions {
  mode: 'shadow' | 'enforce';
  /** Primary/default filesystem root for relative paths. */
  authorizedRoot: string;
  /** Public aliases (normally the primary project slug/name) for authorizedRoot. */
  authorizedRootAliases?: ReadonlyArray<string>;
  /**
   * All roots that may receive writes in this delegated context. Aliases map
   * the public `<project-slug>/...` namespace (and hidden legacy selectors) to
   * a linked real root; absolute paths use longest-prefix matching, including
   * writable external grants.
   */
  filesystemRoots?: ReadonlyArray<{
    rootPath: string;
    aliases?: ReadonlyArray<string>;
    access?: 'read' | 'write';
  }>;
  assertLease: (invocation?: { toolName: string; boundary?: ToolEffectBoundaryKind }) => void;
  snapshot: () => MutationFenceSnapshot;
  bindingTtlMs?: number;
  pollMs?: number;
  onViolation?: (error: Error) => void;
}
