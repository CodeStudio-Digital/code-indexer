export type InboxKind = 'question' | 'notify';
export type InboxStatus = 'pending' | 'delivered' | 'answered' | 'cancelled' | 'expired';
/** Delivery priority (migration 184). Urgent messages are claimed first. */
export type InboxPriority = 'low' | 'normal' | 'urgent';

/**
 * One message between subordinates of the same company session.
 *
 * Either `to_role` or `to_agent_run_id` must be set:
 *   - `to_role` is the loose form, the inbox picks the right run when
 *     several agents are playing the same role
 *   - `to_agent_run_id` pins the message to a specific run
 *
 * `wait_token` is set when the sender called `send_to_agent` with
 * `wait=true` — the InboxQueue uses it to resolve the right pending
 * promise once the answer arrives.
 */
export interface AgentInboxMessage {
  id: number;
  company_session_id: number;
  from_agent_run_id: number;
  from_role: string;
  to_role: string | null;
  to_agent_run_id: number | null;
  kind: InboxKind;
  body: string;
  status: InboxStatus;
  answer: string | null;
  wait_token: string | null;
  created_at: string;
  delivered_at: string | null;
  answered_at: string | null;
  // ─── Threading + priority (migration 184) ───────────────────────
  /** Conversation grouping. Null/absent = this message is its own thread root. */
  thread_id?: number | null;
  /** The message id this one replies to / continues, if any. */
  reply_to_message_id?: number | null;
  /** Delivery priority — 'urgent' is claimed before 'normal'/'low'. Defaults 'normal'. */
  priority?: InboxPriority;
  /** Small structured context payload (card_id, decision_id, file refs) as JSON. */
  context_json?: string | null;
}
