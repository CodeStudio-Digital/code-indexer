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
  CompanyAgentDispatchSource,
} from '@mcp/company-contracts';
import type { StreamActivityBlock } from '../../hooks/agent-stream/types.js';

// ─── Agents ───────────────────────────────────────────────────

export interface AgentStreamState {
  role: string;
  agentRunId: number;
  coderSessionId?: number;
  textChunks: string[];
  toolCalls: ToolCallState[];
  status: AgentRunStatus;
  statusMessage?: string;
  /** App-owned runs carry authoritative configured/effective model provenance
   * on status events; generic Company events may omit these fields. */
  configuredProvider?: string;
  configuredModel?: string;
  effectiveProvider?: string;
  effectiveModel?: string;
  dispatchSource?: CompanyAgentDispatchSource;
  fallbackReason?: string | null;
  usage?: AgentUsage;
  doneReason?: string;
  /** Live "currently doing X" pill (provider call / tool / operation). Null
   *  between actions and on terminal states. Reuses the chat activity block. */
  activity?: StreamActivityBlock | null;
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
  /**
   * P15a — ISO timestamp of the most recent master runner exit. Drives
   * the "Master finished at HH:MM" banner. Cleared when the master is
   * resurrected on the next user turn.
   */
  masterEndedAt: string | null;
  /**
   * P15a — true when the most recent runner exit looked unexpected
   * (errored, or no user message in the prior 30s). Renders an orange
   * persistent banner; false renders a soft auto-dismiss info toast.
   */
  masterEndedUnexpected: boolean;
  /**
   * P15b — milliseconds since the last bus activity at the moment
   * `session_stalled` fired. `null` when the session is making
   * progress; cleared by any activity reducer (board, agent_event, etc.).
   */
  sessionStalledSinceMs: number | null;
  /**
   * P15d — current SSE lifecycle phase. Drives a thin top strip that
   * tells the user we're catching up after a reconnect (`replaying`)
   * or the connection broke and is about to retry (`disconnected`).
   * `connected` field is the boolean health summary; this one carries
   * the finer-grained state.
   */
  connectionPhase: 'connecting' | 'replaying' | 'live' | 'disconnected' | 'idle';
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
  masterEndedAt: null,
  masterEndedUnexpected: false,
  sessionStalledSinceMs: null,
  connectionPhase: 'idle',
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
