import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { ASK_USER_DESC, DECISION_GATE_DESC, maybeTerse } from '@mcp/code-agent/tools/descriptions.js';
import { toolInteractions } from '../core/tool-interactions.js';

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
  info: { kind?: 'plan' | 'question' | 'tasks' | 'spec'; agentRunId?: string | null; role?: string },
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
  mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true, effectBoundary: 'control',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Single-sentence prompt. Keep it short and decision-shaped.' },
      header: {
        type: 'string',
        description: 'Optional UI header, at most 40 characters.',
      },
      options: {
        type: 'array',
        description: 'Prefer 2–8 concise, mutually exclusive choices; omit for a free-text-only question.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Button label, at most 24 characters.' },
            value: { type: 'string', description: 'Returned choice value; prefer snake_case.' },
          },
          required: ['label', 'value'],
        },
        minItems: 2,
        maxItems: 8,
      },
      allow_freeform: { type: 'boolean', description: 'Allow a free-text answer alongside the options.' },
      multi_select: {
        type: 'boolean',
        description: 'Allow multiple choices, returned as values joined by ", ". Default false selects one.',
      },
      filesystem_access: {
        type: 'object',
        description:
          'Optional exact external-folder grant requested from the user. Use only when the user asked to access that folder. ' +
          'When set, options must be exactly authorize/deny and free-form/multi-select are disabled.',
        properties: {
          path: { type: 'string', description: 'Existing absolute directory path requested by the user.' },
          access: { type: 'string', enum: ['read', 'write'], description: 'Requested access; prefer read unless edits are required.' },
        },
        required: ['path', 'access'],
        additionalProperties: false,
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const question = String(args.question ?? '').trim();
    if (!question) return err('question cannot be empty');
    const interaction = toolInteractions(ctx);
    if (!interaction) return err('ask_user tool requires interaction context');

    const header = typeof args.header === 'string' ? args.header.trim() : '';
    if (header.length > 40) {
      return err(`header is too long (${header.length} chars) — keep it under 40. Use the question field for detail.`);
    }

    const optsRaw = Array.isArray(args.options) ? args.options : undefined;
    const filesystemRaw = args.filesystem_access && typeof args.filesystem_access === 'object'
      ? args.filesystem_access as { path?: unknown; access?: unknown }
      : null;
    const filesystemAccess = filesystemRaw
      ? {
          path: String(filesystemRaw.path ?? '').trim(),
          access: filesystemRaw.access === 'write' ? 'write' as const : 'read' as const,
        }
      : null;
    if (filesystemAccess) {
      if (!filesystemAccess.path) return err('filesystem_access.path cannot be empty');
      if (filesystemRaw?.access !== 'read' && filesystemRaw?.access !== 'write') {
        return err("filesystem_access.access must be 'read' or 'write'");
      }
      if (!ctx.authorizeFilesystemRoot) {
        return err('external filesystem access requests are unavailable in this runtime');
      }
    }
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
    if (filesystemAccess) {
      const values = new Set(options?.map((option) => option.value));
      if (options?.length !== 2 || !values.has('authorize') || !values.has('deny')) {
        return err("filesystem access questions require exactly two option values: 'authorize' and 'deny'");
      }
      if (args.allow_freeform || args.multi_select) {
        return err('filesystem access questions cannot allow free-form or multi-select answers');
      }
    }
    const allowFreeform = filesystemAccess ? false : Boolean(args.allow_freeform);
    // multi_select is only meaningful with buttons; ignored for free-form-only.
    const multiSelect = Boolean(args.multi_select) && !!options && options.length > 0;

    const displayedQuestion = filesystemAccess
      ? `${question}\n\nRequested external directory (${filesystemAccess.access === 'write' ? 'read and write' : 'read-only'}):` +
        `\n\n    ${filesystemAccess.path.replace(/[\r\n]+/g, ' ')}`
      : question;
    const id = ctx.ports?.interactions && ctx.currentToolUseId
      ? ctx.currentToolUseId : `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const answer = await interaction.request({ kind: 'question', payload: {
      type: 'question',
      id,
      question: displayedQuestion,
      options,
      allowFreeform,
      multiSelect,
      header: header || undefined,
    } });
    let parsed: {
      aborted?: boolean;
      interrupted?: boolean;
      answer?: string;
      kind?: 'plan' | 'question' | 'tasks';
      agentRunId?: string | null;
      role?: string;
    };
    try { parsed = JSON.parse(answer); } catch { parsed = { answer }; }
    if (parsed.aborted) return err('Question aborted by user.');
    if (parsed.interrupted) {
      return err(formatInterruptedResult('ask_user', parsed));
    }
    if (filesystemAccess && parsed.answer === 'authorize') {
      try {
        const granted = await ctx.authorizeFilesystemRoot!(filesystemAccess.path, filesystemAccess.access);
        return ok(
          `User answered: authorize\nFilesystem root authorized for this session: ` +
            `${granted.rootPath} (${granted.access}).`,
        );
      } catch (error) {
        return err(`Could not authorize filesystem root: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return ok(formatAskUserResult(parsed.answer ?? answer));
  },
};

/** One normalized decision-gate question (shape passed to the UI + format). */
interface DecisionGateOption {
  label: string;
  value: string;
  summary?: string;
  tradeoffs?: string;
}
interface DecisionGateQuestion {
  id: string;
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: DecisionGateOption[];
}
/** User's answers, keyed by question id. `selected` holds chosen option values. */
type DecisionGateAnswers = Record<string, { selected?: string[]; freeform?: string }>;

/**
 * Format the tool_result content for a `decision_gate` response. Shared between
 * the live tool handler and the server-side /decide resume path so a session
 * resumed after a restart produces the byte-identical message the runner would
 * have produced in-process. Iterates `questions` in order (not the answers
 * object's key order) so the output is deterministic, and resolves chosen
 * option values back to their labels for a readable, plan-fillable result.
 */
export function formatDecisionGateResult(
  questions: DecisionGateQuestion[],
  answers: DecisionGateAnswers,
): string {
  const lines: string[] = ['User decided:'];
  for (const q of questions) {
    const a = answers[q.id] ?? {};
    const selected = Array.isArray(a.selected) ? a.selected : [];
    // Trim on both sides so the output is identical whether the questions came
    // from the live handler's normalized args or the /decide resume path's RAW
    // persisted tool_use input (the byte-stability contract). The live handler
    // already trims; the resume route passes raw model args untouched.
    const labels = selected.map((v) => {
      const want = String(v).trim();
      const opt = q.options.find((o) => String(o.value).trim() === want);
      return opt ? String(opt.label).trim() : want;
    });
    const label = q.header?.trim() || q.id;
    const choice = labels.length > 0 ? labels.join(', ') : '(no selection)';
    const freeform = typeof a.freeform === 'string' ? a.freeform.trim() : '';
    const note = freeform ? ` — note: ${freeform}` : '';
    lines.push(`- ${label}: ${choice}${note}`);
  }
  return lines.join('\n');
}

/**
 * decision_gate — present the user a questionnaire of genuine forks
 * (alternative approaches) and wait for their choices. Richer than ask_user:
 * 1–4 questions in one card, each option carrying a summary + tradeoffs, with
 * optional per-question multi-select. The plan agent calls it AFTER
 * investigation and BEFORE submit_plan so the human picks the "via final".
 */
export const decisionGate: CoderTool = {
  name: 'decision_gate',
  description: maybeTerse(DECISION_GATE_DESC),
  source: 'native',
  mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true, effectBoundary: 'control',
  parameters: {
    type: 'object',
    properties: {
      header: {
        type: 'string',
        description: 'Optional short card title (≤40 chars), e.g. "Approach" or "Scope decisions".',
      },
      questions: {
        type: 'array',
        description: 'The decision points (1–4). Each is an independent fork the user owns.',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable snake_case identifier for this question.' },
            header: { type: 'string', description: 'Optional short label (≤40 chars) for this question.' },
            question: { type: 'string', description: 'The decision, as a short markdown prompt.' },
            multi_select: {
              type: 'boolean',
              description: 'When true, the user may pick several options. Default false (single choice).',
            },
            options: {
              type: 'array',
              description: 'The alternative approaches (2–4). Each must carry a one-line summary.',
              minItems: 2,
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Short approach name shown on the button (≤40 chars).' },
                  value: { type: 'string', description: 'Value returned when chosen. snake_case preferred.' },
                  summary: { type: 'string', description: 'One-line description of this approach.' },
                  tradeoffs: { type: 'string', description: 'Optional pros/cons (effort, risk, blast radius, reversibility).' },
                },
                required: ['label', 'value', 'summary'],
              },
            },
          },
          required: ['id', 'question', 'options'],
        },
      },
      allow_freeform: {
        type: 'boolean',
        description: 'When true, the user may also type a free-form answer per question alongside the buttons.',
      },
    },
    required: ['questions'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const interaction = toolInteractions(ctx);
    if (!interaction) return err('decision_gate tool requires interaction context');

    const rawQuestions = Array.isArray(args.questions) ? args.questions : undefined;
    if (!rawQuestions || rawQuestions.length < 1 || rawQuestions.length > 4) {
      return err('decision_gate: `questions` must contain 1–4 items.');
    }

    const header = typeof args.header === 'string' ? args.header.trim() : '';
    if (header.length > 40) return err(`header is too long (${header.length} chars) — keep it under 40.`);

    const seenQuestionIds = new Set<string>();
    const questions: DecisionGateQuestion[] = [];
    for (const raw of rawQuestions) {
      const q = raw as {
        id?: unknown;
        header?: unknown;
        question?: unknown;
        multi_select?: unknown;
        options?: unknown;
      };
      const qid = String(q.id ?? '').trim();
      const qText = String(q.question ?? '').trim();
      if (!qid) return err('every question needs a non-empty `id`.');
      if (seenQuestionIds.has(qid)) return err(`duplicate question id: ${qid}`);
      seenQuestionIds.add(qid);
      if (!qText) return err(`question "${qid}" has an empty \`question\`.`);
      const qHeader = typeof q.header === 'string' ? q.header.trim() : '';
      if (qHeader.length > 40) return err(`question "${qid}" header is too long — keep it under 40 chars.`);

      const rawOpts = Array.isArray(q.options) ? q.options : [];
      if (rawOpts.length < 2 || rawOpts.length > 4) {
        return err(`question "${qid}" must have 2–4 options (got ${rawOpts.length}).`);
      }
      const seenValues = new Set<string>();
      const options: DecisionGateOption[] = [];
      for (const o of rawOpts) {
        const obj = o as { label?: unknown; value?: unknown; summary?: unknown; tradeoffs?: unknown };
        const label = String(obj.label ?? '').trim();
        const value = String(obj.value ?? '').trim();
        const summary = String(obj.summary ?? '').trim();
        if (!label || !value) return err(`question "${qid}": every option needs both label and value.`);
        if (!summary) return err(`question "${qid}", option "${value}": a one-line \`summary\` is required.`);
        if (seenValues.has(value)) return err(`question "${qid}": duplicate option value: ${value}`);
        seenValues.add(value);
        const tradeoffs = typeof obj.tradeoffs === 'string' && obj.tradeoffs.trim() ? obj.tradeoffs.trim() : undefined;
        options.push({ label, value, summary, tradeoffs });
      }
      questions.push({
        id: qid,
        header: qHeader || undefined,
        question: qText,
        multiSelect: Boolean(q.multi_select),
        options,
      });
    }

    const allowFreeform = Boolean(args.allow_freeform);

    const id = ctx.ports?.interactions && ctx.currentToolUseId
      ? ctx.currentToolUseId : `dg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const raw = await interaction.request({ kind: 'decision', payload: {
      id,
      header: header || undefined,
      questions,
      allowFreeform,
    } });
    let parsed: {
      aborted?: boolean;
      interrupted?: boolean;
      answers?: DecisionGateAnswers;
      kind?: 'plan' | 'question' | 'tasks' | 'spec';
      agentRunId?: string | null;
      role?: string;
    };
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    if (parsed.aborted) return err('Decision gate aborted by user.');
    if (parsed.interrupted) {
      return err(formatInterruptedResult('decision_gate', parsed));
    }
    const answers = parsed.answers && typeof parsed.answers === 'object' ? parsed.answers : {};
    return ok(formatDecisionGateResult(questions, answers));
  },
};

export const interactionTools: CoderTool[] = [askUser, decisionGate];
