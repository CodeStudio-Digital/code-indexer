/**
 * read_agent_transcript — parent-side observability for ephemeral subagents
 * (P1 of the ultra-agent parity plan). Renders the RETAINED transcript of a
 * finished spawn/workflow agent as a bounded digest: what it was asked, which
 * tools it called with which inputs, result sizes/excerpts, and its final
 * text. Backed by the resume registry (which now retains completed
 * transcripts too) — nothing here re-enters the child's context or re-runs
 * anything. The dashboard's Transcript tab uses the same renderer via the
 * HTTP route.
 */
import type { CoderTool, ToolContext, ToolResult, JsonSchema } from '@mcp/code-agent/core/tool.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { maybeTerse } from '@mcp/code-agent/tools/descriptions.js';
import {
  getReadableGroup,
  listReadableGroups,
  type ResumeCheckpointStore,
  type ResumableAgentState,
} from '@mcp/code-agent/tools/subagent-resume-registry.js';
import { readSpilledTranscript, readSpilledTranscriptAsync } from '@mcp/code-agent/tools/subagent-transcript-spill.js';
import { renderTranscriptDigest, renderTranscriptDigestAsync } from './subagent-transcript-digest.js';
import type { SessionId } from '@mcp/session-storage';

const DEFAULT_MAX_CHARS = 15_000;
const HARD_MAX_CHARS = 60_000;
/**
 * The renderable transcript for an agent. Resumable agents keep it in RAM;
 * COMPLETED agents have it spilled to a bundle entity (worker RAM stays bounded),
 * so fall back to that file via the retained pointer. Returns [] when neither
 * source has it — the caller then shows the final report instead.
 */
export function resolveAgentTranscript(agent: ResumableAgentState): AgentMessage[] {
  if (agent.transcript && agent.transcript.length > 0) return agent.transcript;
  if (agent.spillPath) return readSpilledTranscript(agent.spillPath) ?? [];
  return [];
}

/** Synchronous compatibility renderer for callers that already own messages. */
export function renderAgentTranscript(agent: ResumableAgentState, opts: { maxChars?: number } = {}): string {
  return renderTranscriptDigest(agent, resolveAgentTranscript(agent), opts.maxChars);
}

/** Tool/UI path: asynchronous spill reads and cooperative digest rendering. */
export async function renderAgentTranscriptAsync(agent: ResumableAgentState,
  opts: { maxChars?: number; signal?: AbortSignal } = {}): Promise<string> {
  opts.signal?.throwIfAborted();
  const messages = agent.transcript?.length ? agent.transcript
    : agent.spillPath ? await readSpilledTranscriptAsync(agent.spillPath, opts.signal) ?? [] : [];
  return renderTranscriptDigestAsync(agent, messages, opts.maxChars, opts.signal);
}
async function renderInventory(
  sessionId: SessionId,
  store?: ResumeCheckpointStore,
): Promise<string> {
  const groups = await listReadableGroups(sessionId, store);
  if (groups.length === 0) {
    return 'read_agent_transcript: no retained agent transcripts in this session yet ' +
      '(bundle transcripts are retained until the session is deleted).';
  }
  const lines = groups.map((g) => {
    const agents = g.agents
      .map((a) => `#${a.agentIndex + 1} ${a.label} [${a.reason}${a.hasTranscript ? '' : ', no transcript'}]`)
      .join(', ');
    return `- spawn_id=${g.spawnId}: ${agents}`;
  });
  return `Retained agent groups (newest first):\n${lines.join('\n')}\n\n` +
    'Call read_agent_transcript({spawn_id, agent}) with a label or 1-based index.';
}

const READ_AGENT_TRANSCRIPT_DESC =
  'Read the retained step-by-step transcript of a finished subagent (spawn_agent, workflow step, or execute_tasks wave): ' +
  'every tool call with inputs, result sizes/excerpts, and its final report. ' +
  'USE: to audit HOW an agent reached its conclusion, or to debug a failed/partial agent before resume_agent.\n' +
  'Call without arguments to list which spawn_ids/agents are readable. Bundle transcripts live until session deletion. ' +
  "DON'T: paste whole transcripts onward — cite the relevant lines.";

const schema: JsonSchema = {
  type: 'object',
  properties: {
    spawn_id: { type: 'string', description: 'Group/spawn id (shown in spawn results and the agents panel). Omit to list readable groups.' },
    agent: {
      type: ['string', 'number'],
      description: 'Agent label OR 1-based index within the group. Optional when the group has a single agent. Numeric 0 is accepted as an alias for the first agent.',
    },
    max_chars: { type: 'number', description: `Digest budget in characters (default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS}).` },
  },
  additionalProperties: false,
} as unknown as JsonSchema;

export function buildReadAgentTranscriptTool(
  store?: ResumeCheckpointStore,
): CoderTool {
  return {
    name: 'read_agent_transcript',
    description: maybeTerse(READ_AGENT_TRANSCRIPT_DESC),
    parameters: schema,
    source: 'native',
    mutates: false,
    handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
      ctx.signal?.throwIfAborted();
      const sessionId = ctx.sessionId ?? ctx.runner?.sessionId;
      if (sessionId == null) return err('read_agent_transcript: no active session.');

      const spawnId = typeof args.spawn_id === 'string' ? args.spawn_id.trim() : '';
      if (!spawnId) return ok(await renderInventory(sessionId, store));

      const group = await getReadableGroup(sessionId, spawnId, store);
      if (!group) {
        return err(
          `read_agent_transcript: spawn '${spawnId}' has no retained group in this session. ` +
          'Call without arguments to list what is readable.',
        );
      }

      const ref = args.agent;
      const agent = resolveRetainedAgent(
        group.agents,
        typeof ref === 'string' || typeof ref === 'number' ? ref : undefined,
      );
      if (!agent) {
        const roster = group.agents.map((a) => `#${a.agentIndex + 1} ${a.label}`).join(', ');
        return err(`read_agent_transcript: pick an agent — group '${spawnId}' has: ${roster}.`);
      }
      // Final-report fallback uses the same bound as a full transcript.
      const maxChars = typeof args.max_chars === 'number' ? args.max_chars : undefined;
      if (agent.nativeTranscriptRef) {
        const tree = ctx.ports?.agentTree;
        if (ctx.runtimeGeneration !== 'rust_v1' || !tree?.readTranscript || tree.ownerAgentRunId !== ctx.controlPlaneParentAgentRunId) {
          return err('read_agent_transcript: the native transcript has no authorized tree reader.');
        }
        return ok(await tree.readTranscript(agent.nativeTranscriptRef, { maxChars, signal: ctx.signal }));
      }
      return ok(await renderAgentTranscriptAsync(agent, { maxChars, signal: ctx.signal }));
    },
  };
}

function resolveRetainedAgent(
  agents: ResumableAgentState[],
  agentRef: string | number | undefined,
): ResumableAgentState | undefined {
  if (typeof agentRef === 'number' && Number.isFinite(agentRef)) {
    const requestedIndex = Math.floor(agentRef);
    // UI/runtime agent arrays are zero-based while this public tool is
    // historically one-based. Zero is outside the public range, so accepting
    // it as a first-agent alias is unambiguous and prevents a needless failed
    // read when a caller forwards an internal index.
    const internalIndex = requestedIndex === 0 ? 0 : requestedIndex - 1;
    return agents.find((a) => a.agentIndex === internalIndex);
  }
  if (typeof agentRef === 'string' && agentRef.trim()) {
    const trimmed = agentRef.trim();
    const byLabel = agents.find((a) => a.label === trimmed);
    if (byLabel) return byLabel;
    const asIndex = Number.parseInt(trimmed, 10);
    if (Number.isFinite(asIndex)) {
      const internalIndex = asIndex === 0 ? 0 : asIndex - 1;
      return agents.find((a) => a.agentIndex === internalIndex);
    }
    return undefined;
  }
  return agents.length === 1 ? agents[0] : undefined;
}

/** Route-facing helper: locate one retained agent (label or 1-based index). */
export async function findRetainedAgent(
  sessionId: SessionId,
  spawnId: string,
  agentRef: string | number | undefined,
  store?: ResumeCheckpointStore,
): Promise<ResumableAgentState | undefined> {
  const group = await getReadableGroup(sessionId, spawnId, store);
  if (!group) return undefined;
  return resolveRetainedAgent(group.agents, agentRef);
}

/** AgentMessage kept import-referenced for route typing convenience. */
export type { AgentMessage };
