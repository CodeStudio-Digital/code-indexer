
export interface AgentsGroupResultSource {
  sessionId: string;
  toolUseId: string;
  input?: Record<string, unknown>;
  isTruncated?: boolean;
}
