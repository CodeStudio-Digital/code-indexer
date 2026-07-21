import type { AssistantTurn, StreamBlock } from '../../hooks/useAgentStream.js';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_ATTACHMENT_TEXT_CHARS,
  MAX_ATTACHMENTS_TOTAL_TEXT_CHARS,
  attachmentPayloadBytes,
  classifyAttachment,
} from '@mcp/shared/attachments/policy.js';
import { TEXT_LIKE_EXTS } from './constants.js';
import type { AgentAttachment, MessageRow, PersistedMessage, VisualGroup } from './types.js';

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs > 0 ? ` ${rs}s` : ''}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm > 0 ? ` ${rm}m` : ''}`;
}

/** Read a Blob/File as base64 (strips the `data:<type>;base64,` prefix). */
export function readDataUrlBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.includes(',') ? result.split(',', 2)[1] : result);
    };
    reader.readAsDataURL(blob);
  });
}

export function fileToAttachment(file: File): Promise<AgentAttachment> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const kind = classifyAttachment(file.name, file.type);
  if (kind === 'unsupported') {
    return Promise.reject(new Error(`Unsupported attachment type: ${file.name}`));
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return Promise.reject(new Error(`${file.name} exceeds the 10 MB attachment limit.`));
  }
  const isImage = file.type.startsWith('image/');
  // RTF must reach the server-side office extractor as base64. Some browsers
  // report it as `text/rtf`, which would otherwise hit the text branch and
  // send raw RTF control-word markup to the model instead of clean text.
  const isRtf = ext === 'rtf' || file.type === 'text/rtf' || file.type === 'application/rtf';
  const isText =
    !isRtf &&
    (file.type.startsWith('text/') || file.type === 'application/json' || TEXT_LIKE_EXTS.has(ext));
  if (isText) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const text = String(reader.result ?? '');
        if (text.length > MAX_ATTACHMENT_TEXT_CHARS) {
          reject(new Error(`${file.name} exceeds the 200,000 character text limit.`));
          return;
        }
        resolve({ name: file.name, mediaType: file.type || 'text/plain', text });
      };
      reader.readAsText(file);
    });
  }
  return readDataUrlBase64(file).then((base64) => ({
    name: file.name,
    mediaType: file.type || (isImage ? 'image/png' : 'application/octet-stream'),
    base64,
  }));
}

/** Validate a complete selection before allocating base64 strings in the renderer. */
export async function filesToAttachments(
  files: FileList | File[],
  existing: AgentAttachment[] = [],
): Promise<AgentAttachment[]> {
  const selected = Array.from(files);
  if (existing.length + selected.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(`You can attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`);
  }

  let totalBytes = existing.reduce((sum, att) => sum + attachmentPayloadBytes(att), 0);
  for (const file of selected) {
    if (classifyAttachment(file.name, file.type) === 'unsupported') {
      throw new Error(`Unsupported attachment type: ${file.name}`);
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${file.name} exceeds the 10 MB attachment limit.`);
    }
    totalBytes += file.size;
  }
  if (totalBytes > MAX_ATTACHMENTS_TOTAL_BYTES) {
    throw new Error('Attachments exceed the 25 MB combined limit.');
  }

  const converted = await Promise.all(selected.map(fileToAttachment));
  const totalTextChars = [...existing, ...converted].reduce(
    (sum, att) => sum + (att.text?.length ?? 0),
    0,
  );
  if (totalTextChars > MAX_ATTACHMENTS_TOTAL_TEXT_CHARS) {
    throw new Error('Text attachments exceed the 400,000 character combined limit.');
  }
  return converted;
}

export function getPersistedAssistantText(message: PersistedMessage): string {
  if (message.role !== 'assistant') return '';
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

export function getCurrentTurnText(turn: AssistantTurn | null): string {
  if (!turn) return '';
  return turn.blocks
    .filter((b): b is StreamBlock & { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function getPersistedAssistantThinkingText(message: PersistedMessage): string {
  if (message.role !== 'assistant') return '';
  return message.content
    .filter((b) => (b as { type?: string }).type === 'thinking')
    .map((b) => (b as { text?: string }).text ?? '')
    .join('\n');
}

function getCurrentTurnThinkingText(turn: AssistantTurn | null): string {
  if (!turn) return '';
  return turn.blocks
    .filter((b): b is StreamBlock & { type: 'thinking'; text: string } => b.type === 'thinking')
    .map((b) => b.text)
    .join('\n');
}

// ─── Live ⇄ persisted block dedup ───────────────────────────────
//
// A gate tool (submit_tasks / submit_plan / decision_gate / ask_user /
// submit_spec) PAUSES the turn awaiting approval, so `message_complete` never
// fires to clear the live buffer. Meanwhile the assistant message is
// checkpoint-persisted and, on reattach/reopen, the re-opened SSE re-emits the
// same gate as a LIVE block while the refetched history already renders the
// PERSISTED card → the user sees the card twice. The text-only
// `liveTurnDuplicatedInHistory` guard can't catch this (gate turns carry no
// text). We dedup at the block level: if a live block's tool_use id already
// exists in persisted history, the persisted card is canonical and the live
// copy is suppressed. We also detect a whole current turn that is already fully
// represented by persisted history (text/thinking plus any persisted tool ids),
// so the live buffer can be hidden/cleared instead of duplicating the final turn.

/** The persisted tool_use id a live block corresponds to, if any. */
export function liveBlockPersistedId(b: StreamBlock): string | undefined {
  switch (b.type) {
    case 'tasks':
      return b.tasks.tool_use_id;
    case 'plan':
      return b.plan.id;
    case 'spec':
      return b.spec.id;
    case 'question':
      return b.question.id;
    case 'decision':
      return b.decision.id;
    case 'tool':
      return b.call.id;
    case 'agents':
      return b.group.toolUseId;
    default:
      return undefined;
  }
}

/** All assistant tool_use ids already persisted to history. */
export function collectPersistedToolUseIds(messages: PersistedMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use' && b.id) ids.add(b.id);
    }
  }
  return ids;
}

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

function askUserSignature(input: unknown): string | undefined {
  const raw = asDict(input);
  const question = cleanText(raw.question);
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

function persistedInteractivePromptSignature(name: string | undefined, input: unknown): string | undefined {
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

function liveBlockPersistedSignature(block: StreamBlock): string | undefined {
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

/** Signatures of interactive prompts in the latest persisted assistant turn. */
export function collectLatestPersistedInteractivePromptSignatures(messages: PersistedMessage[]): Set<string> {
  const signatures = new Set<string>();
  const latestAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!latestAssistant) return signatures;
  for (const b of latestAssistant.content) {
    if (b.type !== 'tool_use') continue;
    const signature = persistedInteractivePromptSignature(b.name, b.input);
    if (signature) signatures.add(signature);
  }
  return signatures;
}

export const collectLatestPersistedGateSignatures = collectLatestPersistedInteractivePromptSignatures;

/** Live blocks NOT yet represented in persisted history (dedup by id or prompt signature). */
export function visibleLiveBlocks(
  blocks: StreamBlock[],
  persistedIds: Set<string>,
  persistedInteractivePromptSignatures: Set<string> = new Set(),
): StreamBlock[] {
  const hasTaskRun = blocks.some((block) => block.type === 'task_run');
  const liveAgentToolUseIds = new Set(
    blocks.flatMap((block) => (
      block.type === 'agents' && block.group.toolUseId ? [block.group.toolUseId] : []
    )),
  );
  const hasPresentationOverlap = hasTaskRun || liveAgentToolUseIds.size > 0
    || blocks.some((block) => block.type === 'agents' && block.group.groupId.startsWith('tasks-wave-'));
  if (
    persistedIds.size === 0
    && persistedInteractivePromptSignatures.size === 0
    && !hasPresentationOverlap
  ) return blocks;
  return blocks.filter((b) => {
    if (b.type === 'agents') {
      // Task waves are already represented by TaskExecutionBlock. For genuine
      // subagents, the rich live card is canonical while it exists, even if
      // the parent tool_use has already checkpointed into history.
      return !b.group.groupId.startsWith('tasks-wave-');
    }
    if (
      b.type === 'tool'
      && (
        (hasTaskRun && b.call.name === 'execute_tasks')
        || (liveAgentToolUseIds.has(b.call.id)
          && ['spawn_agent', 'spawn_agents', 'resume_agent'].includes(b.call.name))
      )
    ) return false;
    const id = liveBlockPersistedId(b);
    if (id && persistedIds.has(id)) return false;
    const signature = liveBlockPersistedSignature(b);
    return !(signature && persistedInteractivePromptSignatures.has(signature));
  });
}

export function isLiveTurnDuplicatedInHistory(
  turn: AssistantTurn | null,
  messages: PersistedMessage[],
  persistedIds: Set<string> = collectPersistedToolUseIds(messages),
): boolean {
  if (!turn || turn.blocks.length === 0) return false;
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!lastAssistant) return false;

  const liveText = getCurrentTurnText(turn).trim();
  const persistedText = getPersistedAssistantText(lastAssistant).trim();
  const liveThinking = getCurrentTurnThinkingText(turn).trim();
  const persistedThinking = getPersistedAssistantThinkingText(lastAssistant).trim();
  const persistedInteractivePromptSignatures = collectLatestPersistedInteractivePromptSignatures(messages);
  let checkedText = false;
  let checkedThinking = false;

  for (const block of turn.blocks) {
    // A rich live agents card remains canonical while present. The persisted
    // spawn tool_use may already exist, but hiding the whole turn here would
    // make both copies disappear because PersistedMessages suppresses its card.
    if (block.type === 'agents') return false;
    if (block.type === 'text') {
      if (!checkedText) {
        if (!liveText || persistedText !== liveText) return false;
        checkedText = true;
      }
      continue;
    }
    if (block.type === 'thinking') {
      if (!checkedThinking) {
        if (!liveThinking || persistedThinking !== liveThinking) return false;
        checkedThinking = true;
      }
      continue;
    }

    const id = liveBlockPersistedId(block);
    if (id) {
      if (persistedIds.has(id)) continue;
      const signature = liveBlockPersistedSignature(block);
      if (signature && persistedInteractivePromptSignatures.has(signature)) continue;
      return false;
    }

    // activity/task_run are live-only visualizations; keep them visible unless
    // a future persisted identity can prove they are duplicates too.
    return false;
  }

  return true;
}

// ─── Visual grouping ────────────────────────────────────────────

/**
 * Sentinel text of the synthetic user message the runner injects after a tool
 * that returned an image (view_image / preview_screenshot) — see
 * `executing.ts`. The image is plumbing the MODEL needs as a user/image block;
 * in the transcript we hide this bubble and instead render the image INLINE
 * under the tool call (so it survives reload, matching the live stream).
 */
export const TOOL_IMAGE_SENTINEL = '(Image(s) attached from the tool call above.)';

/** Tools that emit a tool-result image surfaced via the synthetic user msg. */
export const IMAGE_PRODUCER_TOOLS = new Set(['preview_screenshot', 'view_image']);

/** True when a message is the synthetic tool-image plumbing bubble. */
export function isToolImagePlumbing(msg: PersistedMessage): boolean {
  return (
    msg.role === 'user' &&
    msg.content.some((b) => b.type === 'image') &&
    msg.content.some((b) => b.type === 'text' && (b.text ?? '').trim() === TOOL_IMAGE_SENTINEL)
  );
}

function messageHasText(msg: PersistedMessage): boolean {
  return msg.content.some((b) => b.type === 'text' && (b.text ?? '').trim().length > 0);
}

/**
 * Group flat persisted messages into visual groups for rendering.
 * Consecutive assistant messages that contain only tool_use blocks (no text)
 * are merged into a single visual group. An assistant message with text
 * always starts its own standalone group.
 */
export function groupMessages(
  messages: PersistedMessage[],
  messageRows: MessageRow[],
): VisualGroup[] {
  const groups: VisualGroup[] = [];
  let pending: {
    messages: PersistedMessage[];
    messageIds: (number | undefined)[];
    usages: (MessageRow | undefined)[];
  } | null = null;

  const flushPending = () => {
    if (!pending) return;
    groups.push({
      kind: 'assistant',
      messages: pending.messages,
      messageIds: pending.messageIds,
      usages: pending.usages,
      hasText: false,
    });
    pending = null;
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const row = messageRows[i];

    if (msg.role === 'tool') continue;

    if (msg.role === 'user') {
      flushPending();
      groups.push({ kind: 'user', message: msg, messageId: row?.id, usage: row });
      continue;
    }

    // assistant
    if (messageHasText(msg)) {
      flushPending();
      groups.push({
        kind: 'assistant',
        messages: [msg],
        messageIds: [row?.id],
        usages: [row],
        hasText: true,
      });
    } else {
      // tool-only assistant turn → accumulate
      if (!pending) {
        pending = { messages: [], messageIds: [], usages: [] };
      }
      pending.messages.push(msg);
      pending.messageIds.push(row?.id);
      pending.usages.push(row);
    }
  }
  flushPending();
  return groups;
}

/**
 * A model can make many provider/tool cycles before the user speaks again.
 * Persist those cycles independently, but present them as one assistant turn
 * with one header. Apply this only after the fine-grained render cap so a very
 * large turn cannot bypass the DOM budget.
 */
export function mergeConsecutiveAssistantGroups(groups: VisualGroup[]): VisualGroup[] {
  const merged: VisualGroup[] = [];
  for (const group of groups) {
    const previous = merged[merged.length - 1];
    if (group.kind === 'assistant' && previous?.kind === 'assistant') {
      merged[merged.length - 1] = {
        kind: 'assistant',
        messages: [...previous.messages, ...group.messages],
        messageIds: [...previous.messageIds, ...group.messageIds],
        usages: [...previous.usages, ...group.usages],
        hasText: previous.hasText || group.hasText,
      };
    } else {
      merged.push(group);
    }
  }
  return merged;
}

/** True when the live buffer continues the already-persisted assistant run. */
export function liveTurnContinuesPersistedAssistant(messages: PersistedMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'tool') continue;
    // Runner plumbing/meta input does not represent a new visible user turn.
    if (message.role === 'user' && (message.isMeta || isToolImagePlumbing(message))) continue;
    return message.role === 'assistant';
  }
  return false;
}

export interface LiveAgentIdentity {
  toolUseId?: string;
  groupId: string;
}

/**
 * Prefer a rich live AgentsGroupBlock over the checkpointed spawn_agent card
 * for the same execution. The persisted card returns naturally as soon as the
 * live group leaves currentTurn; no history is deleted or mutated.
 */
export function suppressPersistedAgentDuplicates(
  groups: VisualGroup[],
  liveIdentities: LiveAgentIdentity[],
  resultsById: ReadonlyMap<string, { content?: string }>,
): VisualGroup[] {
  if (liveIdentities.length === 0) return groups;

  const liveToolIds = new Set(liveIdentities.flatMap((identity) => identity.toolUseId ? [identity.toolUseId] : []));
  const liveGroupIds = new Set(liveIdentities.map((identity) => identity.groupId));
  const shouldSuppress = (block: PersistedMessage['content'][number]): boolean => {
    if (
      block.type !== 'tool_use'
      || (block.name !== 'spawn_agent' && block.name !== 'spawn_agents')
    ) return false;
    if (block.id && liveToolIds.has(block.id)) return true;
    const resultText = block.id ? resultsById.get(block.id)?.content ?? '' : '';
    const groupId = persistedAgentGroupId(resultText);
    return Boolean(groupId && liveGroupIds.has(groupId));
  };

  const reconciled: VisualGroup[] = [];
  for (const group of groups) {
    if (group.kind === 'user') {
      reconciled.push(group);
      continue;
    }
    const messages: PersistedMessage[] = [];
    const messageIds: (number | undefined)[] = [];
    const usages: (MessageRow | undefined)[] = [];
    group.messages.forEach((message, index) => {
      const content = message.content.filter((block) => !shouldSuppress(block));
      if (content.length === 0) return;
      messages.push(content.length === message.content.length ? message : { ...message, content });
      messageIds.push(group.messageIds[index]);
      usages.push(group.usages[index]);
    });
    if (messages.length === 0) continue;
    reconciled.push({
      kind: 'assistant',
      messages,
      messageIds,
      usages,
      hasText: messages.some(messageHasText),
    });
  }
  return reconciled;
}

function persistedAgentGroupId(content: string): string | undefined {
  return content.match(/^\[spawn_agent background\][^\n]*\bgroup=(\S+)/m)?.[1]
    ?? content.match(/\[parallel agents:[^\]]*\bgroup=([^,\s\]]+)/)?.[1]
    ?? content.match(/\[subagent [^\]]*\bspawn=([^\s\]]+)/)?.[1];
}
