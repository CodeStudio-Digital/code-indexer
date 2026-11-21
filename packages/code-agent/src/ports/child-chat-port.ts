/**
 * What the coder worker calls for child chats. Every call is made as the
 * worker's own session (`callerId`), and the app checks it: a caller reaches
 * only its own descendants. The app implements it over the child-agent host
 * (create, wait and stop of ChildAgentPort, plus a message to a child and the
 * list of children); the worker reaches it over its bridge to the app
 * (child-chat-bridge-client.ts). Calls that wait use
 * CHILD_AGENT_WAIT_TOOL_TIMEOUT_MS, the others a short deadline.
 */
import type { ChildAgentCreateRequest, ChildAgentWaitRequest, ChildChatTarget } from './child-agent-port.js';
import type { ChildAgentWaitResult, ChildAgentWaitStatus } from '../runtime/child-agent-wait.js';

export interface ChildChatCreated {
  chatId: string;
  title: string;
  profile: string;
  readOnly: boolean;
  created: boolean;
  target?: ChildChatTarget;
}

export interface ChildChatMessageInput {
  kind: 'task' | 'question' | 'notify';
  message: string;
  references?: string[];
  /** Idempotency of the delivery (the tool call id). */
  key: string;
  /** A task nobody waits for: its end reaches the caller as a notice. */
  background: boolean;
  /** Refuse a task to a child that can write (the caller is planning or read-only). */
  readOnlyTargetsOnly?: boolean;
}

export interface ChildChatMessageSent {
  /** When a wait for the child's next final answer starts (a task). */
  since: string;
  /** The mailbox message, when it went through the mailbox (a question waits for its response). */
  messageId?: string;
}

export interface ChildChatListItem {
  chatId: string;
  title: string;
  profile: string;
  depth: number;
  readOnly: boolean;
  status: ChildAgentWaitStatus;
  reason?: string;
}

export type ChildChatWaitRequest = Omit<ChildAgentWaitRequest, 'signal' | 'pollMs'>;

export interface ChildChatPort {
  create(callerId: string, request: ChildAgentCreateRequest): Promise<ChildChatCreated>;
  /** Waits for descendants of the caller; refused for any other chat. */
  wait(callerId: string, request: ChildChatWaitRequest, signal?: AbortSignal): Promise<ChildAgentWaitResult>;
  stop(callerId: string, chatIds: readonly string[]): Promise<{ stopped: string[] }>;
  /**
   * Gives a child of the caller a message. A task starts the child's next run
   * (an explicit new start, also after a stop) or reaches its running one; a
   * question or a notice goes through the mailbox. Null when `chatId` is not
   * a child of the caller.
   */
  message(callerId: string, chatId: string, input: ChildChatMessageInput): Promise<ChildChatMessageSent | null>;
  list(callerId: string): Promise<ChildChatListItem[]>;
}

let current: ChildChatPort | null = null;

/** Installed by the coder worker (its bridge to the app), or by a test. */
export function setChildChatPort(port: ChildChatPort | null): void {
  current = port;
}

export function childChatPort(): ChildChatPort | null {
  return current;
}
