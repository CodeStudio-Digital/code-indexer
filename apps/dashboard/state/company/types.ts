/**
 * Per-domain state shapes consumed by the company store slices.
 *
 * Each slice keeps its state keyed by `companySessionId` so the same
 * store can drive many open sessions (e.g. multiple fronts mounted at
 * once during a navigation animation, or future split-screen layouts).
 *
 * NOTE: these types describe CLIENT state — not wire payloads. SSE
 * payload shapes live in `@mcp/company-contracts`. Reducers translate
 * payloads into these client states.
 */
import type {
  CompanySession,
  KanbanCardFull,
  MasterPrompt,
  AgentRunStatus,
} from '@mcp/company-contracts';

// ─── Agents ───────────────────────────────────────────────────

export interface AgentStreamState {
  role: string;
  agentRunId: number;
  coderSessionId?: number;
  textChunks: string[];
  toolCalls: ToolCallState[];
  status: AgentRunStatus;
  statusMessage?: string;
  usage?: AgentUsage;
  doneReason?: string;
}

export interface ToolCallState {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  durationMs?: number;
}

/**
 * Mirrors the wire shape emitted by `message_complete` events from the
 * coder runner. Snake_case is intentional — the dashboard renders these
 * directly without renaming so renaming would break existing consumers.
 */
export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// ─── Board ────────────────────────────────────────────────────

export interface BoardMessage {
  id: number;
  author_role: string;
  agent_run_id: number | null;
  kind: string;
  content: string;
  mentions: string[];
  created_at: string;
}

// ─── Fallback notices (provider swap on the fly) ──────────────

export interface FallbackNotice {
  at: number;
  agent: string;
  from?: { provider?: string; model?: string };
  to?: { provider?: string; model?: string };
  error?: string;
}

// ─── Stream slice state ───────────────────────────────────────

export interface StreamState {
  connected: boolean;
  started: boolean;
  masterState: AgentStreamState | null;
  subordinateStates: Map<number, AgentStreamState>;
  boardMessages: BoardMessage[];
  masterPrompts: Map<number, MasterPrompt>;
  fallbackNotices: FallbackNotice[];
  error: string | null;
  userMessage: string | null;
  /** Master error detail when `session_idle` reports `master_error`. */
  masterErrorDetail: string | null;
}

export const INITIAL_STREAM_STATE: StreamState = {
  connected: false,
  started: false,
  masterState: null,
  subordinateStates: new Map(),
  boardMessages: [],
  masterPrompts: new Map(),
  fallbackNotices: [],
  error: null,
  userMessage: null,
  masterErrorDetail: null,
};

// ─── Sibling/front-tab slice state ────────────────────────────

export interface SiblingState {
  parent: CompanySession | null;
  children: CompanySession[];
  loading: boolean;
  /**
   * Phase 0 keeps the legacy in-store selection so existing consumers
   * keep working. Phase 1 moves selection to the URL and this field
   * becomes derived from `useParams`.
   */
  activeSessionId: number | null;
}

export const INITIAL_SIBLING_STATE: SiblingState = {
  parent: null,
  children: [],
  loading: false,
  activeSessionId: null,
};

// ─── Kanban slice state ───────────────────────────────────────

export interface KanbanState {
  cards: Map<number, KanbanCardFull>;
  loading: boolean;
  error: string | null;
  /** True once the initial REST fetch landed; SSE-only after that. */
  initialized: boolean;
}

export const INITIAL_KANBAN_STATE: KanbanState = {
  cards: new Map(),
  loading: false,
  error: null,
  initialized: false,
};
