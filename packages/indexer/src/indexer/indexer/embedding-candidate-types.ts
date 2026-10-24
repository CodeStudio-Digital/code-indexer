
export interface CandidateSymbol {
  /** Exact structural identity. Production callers should always provide it. */
  id?: number;
  stable_id?: string | null;
  name: string;
  kind: string;
  signature?: string | null;
  comment?: string | null;
  line?: number | null;
  end_line?: number | null;
  parent?: string | null;
}

export interface CandidateFile {
  path: string;
  fileId: number;
  language: string;
  symbols: CandidateSymbol[];
  content: string;
}

export interface EmbeddingCandidate {
  text: string;
  id: string;
  filePath: string;
  metadata: Record<string, string>;
  hash: string;
  /** Fingerprint used when `hash` was selected. A namespace rollout may
   * change between candidate selection and embedding; the executor then uses
   * `hashForFingerprint` to keep semantic_items aligned with the model that
   * actually produced the vector. */
  embeddingFingerprint?: string;
  hashForFingerprint?: (fingerprint: string) => string;
  /**
   * Persists the candidate's hash. MUST stay synchronous — the executor
   * runs the whole chunk's commits inside ONE better-sqlite3 transaction.
   */
  onCommit: () => void;
  /**
   * Candidates sharing a groupKey form one logical unit (the windows of a
   * multi-chunk symbol body). Batch slicers must keep a group inside a
   * single batch — its hash commit (carried by the LAST member) assumes
   * every earlier window landed in the same or an earlier-successful batch.
   */
  groupKey?: string;
  /**
   * Vector ids made stale by this candidate (a body that shrank from N to
   * M windows leaves ids M..N-1 behind — invisible to the orphan check
   * because the file still exists). The executor deletes them after a
   * successful upsert; failures remain retryable in `semantic_items`.
   */
  supersededIds?: string[];
}

export interface SkippedSymbolGroup {
  sym: CandidateSymbol;
  symDbId: number;
  lineStart: number;
  lineEnd: number;
}
