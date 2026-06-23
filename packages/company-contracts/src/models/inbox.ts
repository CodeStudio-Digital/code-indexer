export type InboxKind = 'question' | 'notify';
export type InboxStatus = 'pending' | 'delivered' | 'answered' | 'cancelled' | 'expired';

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
}
