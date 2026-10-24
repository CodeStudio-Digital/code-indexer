import type { StreamBlock } from '../../hooks/useAgentStream.js';
import type { PersistedMessage } from './types.js';
import { collectPersistedToolResultIds } from './chat-message-text.js';

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict {
  return value && typeof value === 'object' ? (value as Dict) : {};
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function boolish(value: unknown): boolean {
  return value === true;
}

function cleanStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(cleanText).filter(Boolean) : [];
}

function promptSignature(kind: string, payload: unknown): string {
  return `${kind}:${JSON.stringify(payload)}`;
}

function normalizedOptions(value: unknown): Array<{ label: string; value: string; summary?: string; tradeoffs?: string }> {
  const rawOptions = Array.isArray(value) ? value : [];
  return rawOptions.map((oValue) => {
    const o = asDict(oValue);
    const summary = cleanText(o.summary);
    const tradeoffs = cleanText(o.tradeoffs);
    return {
      label: cleanText(o.label),
      value: cleanText(o.value),
      ...(summary ? { summary } : {}),
      ...(tradeoffs ? { tradeoffs } : {}),
    };
  });
}

function submitPlanSignature(input: unknown): string | undefined {
  const raw = asDict(input);
  const plan = cleanText(raw.plan);
  if (!plan) return undefined;
  return promptSignature('submit_plan', { plan, kind: cleanText(raw.kind) || 'mutating' });
}

/**
 * `ask_user` with `filesystem_access` streams an AUGMENTED question (the raw
 * text plus the requested directory) while history persists the raw one. Hashing
 * the augmented form made the two sides disagree and render the card twice, so
 * both are reduced to the raw question first.
 *
 * Kept in sync with the template in
 * `packages/code-agent/src/tools/interaction.ts` (`displayedQuestion`).
 */
const FILESYSTEM_ACCESS_SUFFIX = '\n\nRequested external directory (';

function askUserSignature(input: unknown): string | undefined {
  const raw = asDict(input);
  const displayed = cleanText(raw.question);
  const suffixAt = displayed.indexOf(FILESYSTEM_ACCESS_SUFFIX);
  const question = suffixAt >= 0 ? displayed.slice(0, suffixAt).trim() : displayed;
  if (!question) return undefined;
  return promptSignature('ask_user', {
    header: cleanText(raw.header),
    question,
    options: normalizedOptions(raw.options),
    allowFreeform: boolish(raw.allowFreeform) || boolish(raw.allow_freeform),
  });
}

function decisionGateSignature(input: unknown): string | undefined {
  const raw = asDict(input);
  const rawQuestions = Array.isArray(raw.questions) ? raw.questions : [];
  if (rawQuestions.length === 0) return undefined;
  const questions = rawQuestions.map((qValue, qi) => {
    const q = asDict(qValue);
    return {
      id: cleanText(q.id) || `q_${qi}`,
      header: cleanText(q.header),
      question: cleanText(q.question),
      multiSelect: boolish(q.multiSelect) || boolish(q.multi_select),
      options: normalizedOptions(q.options),
    };
  });
  return promptSignature('decision_gate', {
    header: cleanText(raw.header),
    allowFreeform: boolish(raw.allowFreeform) || boolish(raw.allow_freeform),
    questions,
  });
}

function submitSpecSignature(input: unknown): string | undefined {
  const raw = asDict(input);
  const name = cleanText(raw.name);
  const body = cleanText(raw.body);
  if (!name || !body) return undefined;
  return promptSignature('submit_spec', { name, body, parentId: cleanText(raw.parent_id) || cleanText(raw.parentId) });
}

function normalizedTaskItems(input: unknown): unknown[] {
  const raw = asDict(input);
  if (Array.isArray(raw.items)) return raw.items;
  if (Array.isArray(raw.tasks)) return raw.tasks;
  return [];
}

function normalizedTaskItem(value: unknown, index: number) {
  const task = asDict(value);
  const references = Array.isArray(task.references)
    ? task.references.map((refValue) => {
        const ref = asDict(refValue);
        return {
          type: cleanText(ref.type),
          value: cleanText(ref.value),
          file: cleanText(ref.file),
          lines: cleanText(ref.lines),
          note: cleanText(ref.note),
        };
      })
    : [];
  return {
    id: cleanText(task.id) || `alias_${index + 1}`,
    title: cleanText(task.title),
    description: cleanText(task.description),
    files: cleanStringArray(task.files),
    references,
    depends_on: cleanStringArray(task.depends_on),
    suggested_mode: cleanText(task.suggested_mode) || 'inline',
    estimated_complexity: cleanText(task.estimated_complexity),
  };
}

function tasksPromptSignature(input: unknown): string | undefined {
  const tasks = normalizedTaskItems(input).map(normalizedTaskItem);
  if (tasks.length === 0) return undefined;
  return promptSignature('task_list_approve', { summary: cleanText(asDict(input).summary), tasks });
}

function taskListInputIsApprove(input: unknown): boolean {
  const raw = asDict(input);
  if (cleanText(raw.gate) === 'approve') return true;
  return normalizedTaskItems(input).some((item) => {
    const task = asDict(item);
    return !!cleanText(task.title) || Array.isArray(task.files);
  });
}

/**
 * Content signature of a PERSISTED interactive prompt. Pair it with
 * `liveBlockPersistedSignature` to bridge a live card (runtime id) to its
 * persisted twin (provider id) — the two never share an id.
 */
export function persistedInteractivePromptSignature(name: string | undefined, input: unknown): string | undefined {
  switch (name) {
    case 'submit_plan':
      return submitPlanSignature(input);
    case 'ask_user':
      return askUserSignature(input);
    case 'decision_gate':
      return decisionGateSignature(input);
    case 'submit_spec':
      return submitSpecSignature(input);
    case 'submit_tasks':
      return tasksPromptSignature(input);
    case 'task_list':
      return taskListInputIsApprove(input) ? tasksPromptSignature(input) : undefined;
    default:
      return undefined;
  }
}

export function liveBlockPersistedSignature(block: StreamBlock): string | undefined {
  switch (block.type) {
    case 'tasks':
      return tasksPromptSignature({ summary: block.tasks.summary, tasks: block.tasks.tasks });
    case 'plan':
      return submitPlanSignature(block.plan);
    case 'spec':
      return submitSpecSignature(block.spec);
    case 'question':
      return askUserSignature(block.question);
    case 'decision':
      return decisionGateSignature(block.decision);
    default:
      return undefined;
  }
}

/**
 * Signatures of PENDING interactive prompts in the latest persisted assistant
 * turn. IDs are always the primary identity. A content signature is only a
 * bridge between the provider's tool_use id and the richer runtime prompt id
 * (for example `toolu_*` versus `plan_*`) while no tool_result exists yet.
 *
 * Resolved prompts must never participate in signature dedup: a newly submitted
 * prompt may intentionally have byte-identical content.
 */
export function collectLatestPersistedInteractivePromptSignatures(
  messages: PersistedMessage[],
  persistedResultIds: Set<string> = collectPersistedToolResultIds(messages),
): Set<string> {
  const signatures = new Set<string>();
  let latestAssistant: PersistedMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'assistant') {
      latestAssistant = messages[index];
      break;
    }
  }
  if (!latestAssistant) return signatures;
  for (const b of latestAssistant.content) {
    if (b.type !== 'tool_use') continue;
    if (b.id && persistedResultIds.has(b.id)) continue;
    const signature = persistedInteractivePromptSignature(b.name, b.input);
    if (signature) signatures.add(signature);
  }
  return signatures;
}
