/**
 * Process-global port for the Session Drive investigation semantic index.
 *
 * The code-agent owns the relational ledger and lexical fallback, while the
 * HTTP host owns Knowledge-profile inference, generation control and the
 * worker-backed project vectors.db. Keeping this as a narrow port prevents
 * code-agent worker threads from opening sqlite-vec or persisting vectors in
 * the central database. Worker/no-host runs leave the port null and therefore
 * remain lexical-only.
 */
export interface InvestigationSemanticRecord {
  id: number;
  project_id: number | null;
  session_id: number | null;
  topic: string;
  summary: string;
  body: string;
  source_label: string | null;
  agent_type: string | null;
  tokens: number;
  created_at: string;
}

export interface InvestigationSemanticIndexPort {
  /** Wake the host after SessionStore has durably fenced + committed the row. */
  wakeUpsert(record: InvestigationSemanticRecord): void;
  /** Return investigation ids in vector rank order. Empty means lexical fallback. */
  search(input: {
    sessionId: number;
    query: string;
    limit: number;
  }): Promise<number[]>;
}

let indexPort: InvestigationSemanticIndexPort | null = null;

export function setInvestigationSemanticIndex(port: InvestigationSemanticIndexPort | null): void {
  indexPort = port;
}

export function getInvestigationSemanticIndex(): InvestigationSemanticIndexPort | null {
  return indexPort;
}
