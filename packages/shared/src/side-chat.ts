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

export interface SideChatModelChoice {
  provider: string;
  model: string;
  effort: string | null;
}

export interface SideChatTarget extends SideChatModelChoice {
  /** Undefined in side chats saved before model selection was available. */
  effortOverride?: string | null;
  thinking: boolean;
  contextWindow: number;
}

export interface SideChatTurn {
  id: string;
  question: string;
  selection?: SideChatSelection;
  context: SideChatContextInfo;
  target?: SideChatTarget;
  answer: string;
  reasoning?: boolean;
  status: 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  error?: string;
  usage?: { input: number; output: number; cached: number };
  firstTextMs?: number;
}

/** The answer contains only the text starting at this UTF-16 offset. */
export type SideChatProgress = Pick<SideChatTurn, 'status' | 'answer' | 'reasoning' | 'usage' | 'firstTextMs' | 'error'> & { offset: number };

export interface SideChatView {
  id: string;
  parentId: string;
  target: SideChatTarget;
  context: SideChatContextInfo;
  turns: SideChatTurn[];
  selection: SideChatSelection | null;
}
