import type { CoderTool, ToolResult } from '../core/tool.js';
import { ok, err } from '../core/tool.js';
import { ASK_USER_DESC, maybeTerse } from './descriptions.js';

/**
 * Format the tool_result content for an ask_user response. Shared between the
 * live tool handler and the server-side resume path so a session resumed
 * after a restart produces the byte-identical message the runner would have.
 */
export function formatAskUserResult(answer: string): string {
  return `User answered: ${answer}`;
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
      question: { type: 'string', description: 'The question to ask.' },
      options: {
        type: 'array',
        description: 'Optional list of pre-defined answer options. When provided, UI shows buttons.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['label', 'value'],
        },
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

    const optsRaw = Array.isArray(args.options) ? args.options : undefined;
    const options = optsRaw?.map((o) => {
      const obj = o as { label?: unknown; value?: unknown };
      return { label: String(obj.label ?? ''), value: String(obj.value ?? '') };
    });
    const allowFreeform = Boolean(args.allow_freeform);

    const id = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    runner.emit('question_posted', {
      type: 'question',
      id,
      question,
      options,
      allowFreeform,
    });

    const answer = await runner.waitForUserInput();
    let parsed: { aborted?: boolean; interrupted?: boolean; answer?: string };
    try { parsed = JSON.parse(answer); } catch { parsed = { answer }; }
    if (parsed.aborted) return err('Question aborted by user.');
    if (parsed.interrupted) {
      return err(
        'ask_user was interrupted: a subordinate agent is blocked waiting for your response. ' +
        'Use answer_subordinate_question() or approve_subordinate_tasks() to unblock them first, ' +
        'then call ask_user again when ready.',
      );
    }
    return ok(formatAskUserResult(parsed.answer ?? answer));
  },
};

export const interactionTools: CoderTool[] = [askUser];
