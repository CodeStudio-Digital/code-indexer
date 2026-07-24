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
  getGroup,
  listReadableGroups,
  type ResumableAgentState,
} from '@mcp/code-agent/tools/subagent-resume-registry.js';
import { readSpilledTranscript } from '@mcp/code-agent/tools/subagent-transcript-spill.js';

const DEFAULT_MAX_CHARS = 15_000;
const HARD_MAX_CHARS = 60_000;
const TOOL_INPUT_CHARS = 220;
const TOOL_RESULT_CHARS = 240;
const TEXT_BLOCK_CHARS = 900;

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function describeInput(input: Record<string, unknown>): string {
  try {
    return clip(JSON.stringify(input), TOOL_INPUT_CHARS);
  } catch {
    return '(unserializable input)';
  }
}

/**
 * The renderable transcript for an agent. Resumable agents keep it in RAM;
 * COMPLETED agents have it spilled to a JSONL file (worker RAM stays bounded),
 * so fall back to that file via the retained pointer. Returns [] when neither
 * source has it — the caller then shows the final report instead.
 */
export function resolveAgentTranscript(agent: ResumableAgentState): AgentMessage[] {
  if (agent.transcript && agent.transcript.length > 0) return agent.transcript;
  if (agent.spillPath) return readSpilledTranscript(agent.spillPath) ?? [];
  return [];
}

/** One line per transcript event — compact, chronological, tool-centric. */
export function renderAgentTranscript(
  agent: ResumableAgentState,
  opts: { maxChars?: number } = {},
): string {
  const maxChars = Math.min(HARD_MAX_CHARS, Math.max(2_000, opts.maxChars ?? DEFAULT_MAX_CHARS));
  const tokens = (agent.usage.input_tokens ?? 0) + (agent.usage.output_tokens ?? 0);
  const header =
    `[transcript agent=#${agent.agentIndex + 1} "${agent.label}" profile=${agent.profileId} ` +
    `status=${agent.reason} tools=${agent.toolCallCount} tokens=${tokens} attempt=${agent.attempt}]\n` +
    `Task: ${clip(agent.task, 400)}\n`;
  const lines: string[] = [];
  const toolNames = new Map<string, string>();
  for (const message of resolveAgentTranscript(agent)) {
    for (const block of message.content) {
      if (block.type === 'text' && message.role === 'user') {
        lines.push(`[user] ${clip(block.text, TEXT_BLOCK_CHARS)}`);
      } else if (block.type === 'text' && message.role === 'assistant') {
        if (block.text.trim()) lines.push(`[assistant] ${clip(block.text, TEXT_BLOCK_CHARS)}`);
      } else if (block.type === 'tool_use') {
        toolNames.set(block.id, block.name);
        lines.push(`  → ${block.name} ${describeInput(block.input)}`);
      } else if (block.type === 'tool_result') {
        const name = toolNames.get(block.tool_use_id) ?? 'tool';
        const flag = block.is_error ? ' [ERROR]' : '';
        lines.push(`  ← ${name}${flag} (${block.content.length} chars) ${clip(block.content, TOOL_RESULT_CHARS)}`);
      } else if (block.type === 'thinking' && block.text.trim()) {
        lines.push(`  ~ thinking (${block.text.length} chars)`);
      }
    }
  }
  if (agent.failureNote) lines.push(`[failure] ${clip(agent.failureNote, 500)}`);
  if (agent.finalText?.trim()) lines.push(`[final] ${clip(agent.finalText, 2_000)}`);

  // Char budget: keep the header + protect the TAIL (recent activity + final)
  // by dropping middle lines first.
  let body = lines.join('\n');
  if (header.length + body.length > maxChars) {
    const kept: string[] = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const cost = lines[i].length + 1;
      if (used + cost > maxChars - header.length - 60) break;
      kept.unshift(lines[i]);
      used += cost;
    }
    body = `[… ${lines.length - kept.length} earlier event(s) elided — raise max_chars to see more]\n${kept.join('\n')}`;
  }
  return `${header}\n${body}`;
}

function renderInventory(sessionId: number): string {
  const groups = listReadableGroups(sessionId);
  if (groups.length === 0) {
    return 'read_agent_transcript: no retained agent transcripts in this session yet ' +
      '(they are kept in memory for ~45min after each spawn_agent/workflow run).';
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
  'Call without arguments to list which spawn_ids/agents are readable. Transcripts live in memory ~45min. ' +
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

export function buildReadAgentTranscriptTool(): CoderTool {
  return {
    name: 'read_agent_transcript',
    description: maybeTerse(READ_AGENT_TRANSCRIPT_DESC),
    parameters: schema,
    source: 'native',
    mutates: false,
    handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
      const sessionId = ctx.runner?.sessionId;
      if (sessionId == null) return err('read_agent_transcript: no active session.');

      const spawnId = typeof args.spawn_id === 'string' ? args.spawn_id.trim() : '';
      if (!spawnId) return ok(renderInventory(sessionId));

      const group = getGroup(sessionId, spawnId);
      if (!group) {
        return err(
          `read_agent_transcript: spawn '${spawnId}' not found — retained state expires ~45min ` +
          'after the run and does not survive restarts. Call without arguments to list what is readable.',
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
      // A completed agent's transcript may be spilled to disk (no in-RAM copy);
      // renderAgentTranscript falls back to the spill file via agent.spillPath.
      if ((!agent.transcript || agent.transcript.length === 0) && !agent.spillPath) {
        return ok(
          `Agent #${agent.agentIndex + 1} "${agent.label}" [${agent.reason}] has no retained transcript ` +
          `(retention off or evicted by the byte cap). Final report:\n\n${agent.finalText || '(empty)'}`,
        );
      }
      const maxChars = typeof args.max_chars === 'number' ? args.max_chars : undefined;
      return ok(renderAgentTranscript(agent, { maxChars }));
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
export function findRetainedAgent(
  sessionId: number,
  spawnId: string,
  agentRef: string | number | undefined,
): ResumableAgentState | undefined {
  const group = getGroup(sessionId, spawnId);
  if (!group) return undefined;
  return resolveRetainedAgent(group.agents, agentRef);
}

/** AgentMessage kept import-referenced for route typing convenience. */
export type { AgentMessage };
