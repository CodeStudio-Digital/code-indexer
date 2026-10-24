export interface PreparedWorkspaceInput {
  readonly projectRoot: string;
  readonly existingPath?: string | null;
  readonly requested?: { name?: string; branch?: string };
  readonly signal?: AbortSignal;
  persist(path: string): Promise<void>;
}

/** The product owns Git process containment and workspace admission before
 * catalog/prompt construction seals the actual execution directory. */
export type PreparedWorkspaceFactory = (input: PreparedWorkspaceInput) => Promise<string>;
