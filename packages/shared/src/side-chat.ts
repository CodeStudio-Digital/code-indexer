export interface SideChatSelection {
  /** Null identifies a quote from the visible, in-progress reply. */
  seq: number | null;
  text: string;
}

export interface SideChatContextInfo {
  revision: string;
  throughSeq: number;
  capturedAt: string;
  truncated: boolean;
}

export interface SideChatTarget {
  provider: string;
  model: string;
  effort: string | null;
  thinking: boolean;
  contextWindow: number;
}

export interface SideChatTurn {
  id: string;
  question: string;
  selection?: SideChatSelection;
  context: SideChatContextInfo;
  answer: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  error?: string;
  usage?: { input: number; output: number; cached: number };
  firstTextMs?: number;
}

export interface SideChatView {
  id: string;
  parentId: string;
  target: SideChatTarget;
  context: SideChatContextInfo;
  turns: SideChatTurn[];
  selection: SideChatSelection | null;
}
