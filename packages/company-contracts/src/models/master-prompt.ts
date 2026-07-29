export type MasterPromptKind = 'question' | 'plan';
export type MasterPromptStatus = 'pending' | 'answered' | 'cancelled';

export interface MasterPromptOption {
  label: string;
  value: string;
}

export interface MasterPrompt {
  id: string;
  company_session_id: string;
  agent_run_id: string | null;
  kind: MasterPromptKind;
  runner_block_id: string | null;
  /** Question text or plan text. */
  body: string;
  options: MasterPromptOption[] | null;
  allow_freeform: boolean;
  status: MasterPromptStatus;
  /** Set when kind='question' and status='answered'. */
  answer: string | null;
  /** Set when kind='plan' and status='answered'. */
  approved: boolean | null;
  /** Set when kind='plan' and status='answered'. */
  feedback: string | null;
  created_at: string;
  resolved_at: string | null;
}
