import type { AgentInboxMessage, InboxKind, InboxPriority } from '@mcp/company/types.js';
export interface SendArgs {
  fromAgentRunId: string;
  fromRole: string;
  toRole?: string;
  toAgentRunId?: string;
  kind: InboxKind;
  body: string;
  /** When true the caller must follow up with `waitForAnswer(token)`. */
  wait: boolean;
  /**
   * C6 — when true, `send()` runs `assessTargetHealth()` BEFORE creating
   * the inbox row and throws `HealthCheckError` if the target is
   * overloaded / failed / stale. Default false (legacy behavior:
   * messages always queue and rely on the timeout to fire EXPIRED).
   * Global default flipped by `MCP_COMPANY_INBOX_HEALTH_CHECK=1`.
   */
  failFastOnHealth?: boolean;
  // ─── Threading + priority (migration 184) ───────────────────────
  /** Delivery priority — 'urgent' claims before 'normal'/'low'. Default 'normal'. */
  priority?: InboxPriority;
  /** Conversation this belongs to. Omit → the new message roots its own thread. */
  threadId?: string | null;
  /** The message this one replies to / continues. */
  replyToMessageId?: string | null;
  /** Small structured context payload (card_id/decision_id/file refs) as JSON. */
  contextJson?: string | null;
}

export interface SendResult {
  message: AgentInboxMessage;
  /** True when the queue could route the message immediately (target idle). */
  deliveredImmediately: boolean;
  /** Set when `wait=true`; pass to `waitForAnswer` to resolve when answered. */
  waitToken?: string;
}
