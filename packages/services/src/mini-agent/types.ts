/**
 * A minimal, tool-constrained agent loop. Unlike the coder runner it owns no
 * session, persistence, worktree, skills, MCP, or system-prompt machinery — it
 * is scoped BY CONSTRUCTION: only the tools you pass exist, and the system
 * prompt you pass is the only guardrail. Used for domain-locked assistants
 * (e.g. "Cloudflare only — anything that escapes dies"), where confinement
 * comes from the empty surrounding surface, not from filtering a big registry.
 */

/** A tool the mini-agent may call. `mutates` gates the confirmation step. */
export interface MiniTool {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  parameters: Record<string, unknown>;
  /** Mutating/destructive tools require user confirmation before running. */
  mutates?: boolean;
  handler: (args: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>;
}

/** A pending tool call awaiting user approval. */
export interface MiniConfirmCall {
  callId: string;
  name: string;
  input: Record<string, unknown>;
}

/** Streamed events from a mini-agent run. */
export type MiniDelta =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; callId: string; name: string; input: Record<string, unknown> }
  | { type: 'confirm_request'; callId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; name: string; content: string; isError?: boolean }
  | { type: 'error'; message: string }
  | { type: 'done'; reason: 'stop' | 'max_steps' };

/** Decide whether a pending mutating call may run. Resolves true to proceed. */
export type MiniConfirmFn = (call: MiniConfirmCall) => Promise<boolean>;

export interface RunMiniAgentOpts {
  /** Provider-agnostic chat client (build via createCoderProvider). */
  provider: import('@mcp/code-agent/providers/adapter.js').ChatProvider;
  /** The ONLY guardrail — e.g. the Cloudflare scope + refusal rule. */
  system: string;
  /** Tools the agent may call. Anything else simply doesn't exist. */
  tools: MiniTool[];
  /** Conversation so far (the new user turn is the last message). */
  messages: import('@mcp/code-agent/core/messages.js').AgentMessage[];
  /** Gate for mutating tools. Omit to auto-approve (non-interactive). */
  confirm?: MiniConfirmFn;
  signal?: AbortSignal;
  /** Hard cap on model↔tool round-trips. Default 12. */
  maxSteps?: number;
}
