/**
 * record_memo — Frente C (PR 3 da reavaliação).
 *
 * Tool exposed exclusively inside subagents (implement / verify / full).
 * Lets the sub explicitly emit a short structured note that the parent
 * runner reads back AFTER the subagent finishes. Bridges the
 * "summary-only" gap where intermediate findings used to vanish.
 *
 * The tool itself does NOT persist anywhere durable — it only appends
 * to the in-memory `ctx.subagentCollector`. Persistence is the parent's
 * job (it can pipe collector contents into a session input, kanban
 * comment, …) once the sub returns.
 *
 * Capped at 50 memos per run (`CODER_SUBAGENT_MAX_MEMOS`). Beyond the
 * cap returns success but logs and drops the entry — preferable to
 * throwing mid-sub which would abort the whole task.
 */
import type { CoderTool, ToolResult, ToolContext, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';

const MEMO_KINDS = ['observation', 'decision', 'warning', 'progress'] as const;

const RECORD_MEMO_DESC =
  'Save a short structured note that the PARENT agent will read after you finish.\n\n' +
  'Use this whenever you discover something the parent should know but that won\'t make it into ' +
  'your final summary — a surprising file location, a risk you noticed, a partial result before ' +
  'you continue, a decision you took.\n\n' +
  'USE: report intermediate observations / decisions / warnings / progress milestones.\n' +
  "DON'T: dump full file contents (use snapshot for that). Don't repeat what's already in your " +
  'final summary text. Keep each memo under ~300 chars.\n\n' +
  '`kind`: "observation" (default), "decision", "warning", "progress".\n' +
  'Max 50 memos per run; beyond that, calls succeed but the entry is dropped.';

const recordMemoSchema: JsonSchema = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'The memo content. Keep under 300 chars. Concrete > vague.',
    },
    kind: {
      type: 'string',
      enum: ['observation', 'decision', 'warning', 'progress'],
      description:
        '"observation" (default) — neutral finding. ' +
        '"decision" — choice you made the parent should know. ' +
        '"warning" — risk / blocker / unexpected behaviour. ' +
        '"progress" — milestone before continuing the task.',
    },
  },
  required: ['text'],
  additionalProperties: false,
} as unknown as JsonSchema;

export const recordMemoTool: CoderTool = {
  name: 'record_memo',
  effectBoundary: 'control',
  description: RECORD_MEMO_DESC,
  parameters: recordMemoSchema,
  source: 'native',
  mutates: false,
  parallelSafe: true,
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const collector = (ctx as ToolContext & { subagentCollector?: { recordMemo: (t: string, k?: string) => boolean } })
      .subagentCollector;
    if (!collector) {
      return err(
        'record_memo: this tool only works inside a subagent run. ' +
        'The parent agent does not need it (its assistant text is already the deliverable).',
      );
    }
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) return err('record_memo: `text` is required and non-empty.');
    const kindRaw = typeof args.kind === 'string' ? args.kind : 'observation';
    const kind = (MEMO_KINDS as readonly string[]).includes(kindRaw) ? kindRaw : 'observation';
    const accepted = collector.recordMemo(text, kind);
    if (!accepted) {
      return ok(
        `memo dropped (per-run cap reached). Continue with the task; ` +
        `the parent will see what was collected so far.`,
      );
    }
    return ok(`memo recorded [${kind}]: "${text.length > 80 ? text.slice(0, 77) + '...' : text}"`);
  },
};
