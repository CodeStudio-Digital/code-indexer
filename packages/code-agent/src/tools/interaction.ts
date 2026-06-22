import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { ASK_USER_DESC, maybeTerse } from '@mcp/code-agent/tools/descriptions.js';

/**
 * Format the tool_result content for an ask_user response. Shared between the
 * live tool handler and the server-side resume path so a session resumed
 * after a restart produces the byte-identical message the runner would have.
 */
export function formatAskUserResult(answer: string): string {
  return `User answered: ${answer}`;
}

/**
 * Build a structured tool_result for an interactive tool that was interrupted
 * by an urgent subordinate event. The first line is a JSON envelope with
 * `next_action` so the model can be reliably routed; the second line is a
 * short human-readable hint for transcripts.
 */
export function formatInterruptedResult(
  toolName: string,
  info: { kind?: 'plan' | 'question' | 'tasks' | 'spec'; agentRunId?: number; role?: string },
): string {
  const action =
    info.kind === 'plan'
      ? 'approve_subordinate_plan'
      : info.kind === 'tasks'
      ? 'approve_subordinate_tasks'
      : info.kind === 'question'
      ? 'answer_subordinate_question'
      : info.kind === 'spec'
      ? 'approve_subordinate_spec'
      : null;
  const envelope = JSON.stringify({
    interrupted: true,
    interrupted_tool: toolName,
    next_action: action,
    agent_run_id: info.agentRunId ?? null,
    role: info.role ?? null,
  });
  const hint = action
    ? `${toolName} was interrupted: subordinate ${info.role ?? '?'} (agent_run_id=${info.agentRunId ?? '?'}) is BLOCKED waiting on you. Call ${action}() first, then retry ${toolName}.`
    : `${toolName} was interrupted: an urgent subordinate event arrived. Handle it first, then retry ${toolName}.`;
  return `${envelope}\n${hint}`;
}

/**
 * ask_user — pause the run and ask the user a question. Supports free-form
 * answers or a list of pre-defined options (rendered as buttons in the UI).
 */
export const askUser: CoderTool = {
  name: 'ask_user',
  description: maybeTerse(ASK_USER_DESC),
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Single-sentence prompt. Keep it short and decision-shaped.' },
      header: {
        type: 'string',
        description: 'Optional short UI label (≤40 chars). Shown above the question in the dashboard.',
      },
      options: {
        type: 'array',
        description:
          'Pre-defined answer options. STRONGLY PREFERRED — when provided, must be 2–8 mutually exclusive choices. ' +
          'UI renders them as buttons in a 2-column grid. Keep the list short and decision-shaped — if you find yourself ' +
          'reaching 8, consider whether two of them collapse into one or whether the question itself is too broad. ' +
          'If you only need free-form (no buttons), omit this field.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Button label shown in the UI. Keep ≤24 chars.' },
            value: { type: 'string', description: 'Value returned to the agent when the user picks this option. snake_case preferred.' },
          },
          required: ['label', 'value'],
        },
        minItems: 2,
        maxItems: 8,
      },
      allow_freeform: { type: 'boolean', description: 'When true and options are given, also allow a free-form answer alongside the buttons.' },
    },
    required: ['question'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const question = String(args.question ?? '').trim();
    if (!question) return err('question cannot be empty');
    const runner = ctx.runner;
    if (!runner) return err('ask_user tool requires runner context');

    const header = typeof args.header === 'string' ? args.header.trim() : '';
    if (header.length > 40) {
      return err(`header is too long (${header.length} chars) — keep it under 40. Use the question field for detail.`);
    }

    const optsRaw = Array.isArray(args.options) ? args.options : undefined;
    if (optsRaw !== undefined) {
      if (optsRaw.length < 2 || optsRaw.length > 8) {
        return err(
          `ask_user: when options is provided, it must contain 2–8 mutually-exclusive choices (got ${optsRaw.length}). ` +
            `If you only have one choice, omit options entirely. If you have more than 8, the question is probably too ` +
            `broad — split into a coarser top-level question first, then drill down based on the answer.`,
        );
      }
    }
    const options = optsRaw?.map((o) => {
      const obj = o as { label?: unknown; value?: unknown };
      return { label: String(obj.label ?? ''), value: String(obj.value ?? '') };
    });
    if (options) {
      const seen = new Set<string>();
      for (const o of options) {
        if (!o.label || !o.value) return err('every option must have both label and value');
        if (seen.has(o.value)) return err(`duplicate option value: ${o.value}`);
        seen.add(o.value);
      }
    }
    const allowFreeform = Boolean(args.allow_freeform);

    const id = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    runner.emit('question_posted', {
      type: 'question',
      id,
      question,
      options,
      allowFreeform,
      header: header || undefined,
    });

    const answer = await runner.waitForUserInput();
    let parsed: {
      aborted?: boolean;
      interrupted?: boolean;
      answer?: string;
      kind?: 'plan' | 'question' | 'tasks';
      agentRunId?: number;
      role?: string;
    };
    try { parsed = JSON.parse(answer); } catch { parsed = { answer }; }
    if (parsed.aborted) return err('Question aborted by user.');
    if (parsed.interrupted) {
      return err(formatInterruptedResult('ask_user', parsed));
    }
    return ok(formatAskUserResult(parsed.answer ?? answer));
  },
};

export const interactionTools: CoderTool[] = [askUser];
