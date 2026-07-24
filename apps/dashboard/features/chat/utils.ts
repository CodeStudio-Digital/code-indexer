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

export interface FileAttachmentOptions {
  /** Prefer a local path reference for files that do not require inline bytes. */
  preferFileReferences?: boolean;
  /** Pre-resolved by filesToAttachments so the bridge is called only once. */
  nativePath?: string;
}

/** Images and structured documents need bytes for vision/native parsers. */
function requiresInlinePayload(kind: ReturnType<typeof classifyAttachment>): boolean {
  return kind === 'image' || kind === 'pdf' || kind === 'office';
}

function nativeFileReference(file: File, prefer: boolean): string | undefined {
  if (!prefer) return undefined;
  try {
    const bridge = (globalThis as typeof globalThis & {
      electronAPI?: { getPathForFile?: (value: File) => string };
    }).electronAPI;
    const path = bridge?.getPathForFile?.(file)?.trim();
    return path || undefined;
  } catch {
    return undefined;
  }
}

export function fileToAttachment(
  file: File,
  options: FileAttachmentOptions = {},
): Promise<AgentAttachment> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const kind = classifyAttachment(file.name, file.type);
  const nativePath = options.nativePath
    ?? (!requiresInlinePayload(kind)
      ? nativeFileReference(file, options.preferFileReferences === true)
      : undefined);
  if (nativePath) {
    return Promise.resolve({
      name: file.name || nativePath.split(/[\\/]/).pop() || 'attachment',
      mediaType: file.type || 'application/octet-stream',
      path: nativePath,
    });
  }
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
  options: Pick<FileAttachmentOptions, 'preferFileReferences'> = {},
): Promise<AgentAttachment[]> {
  const selected = Array.from(files);
  if (existing.length + selected.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(`You can attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`);
  }

  const planned = selected.map((file) => {
    const kind = classifyAttachment(file.name, file.type);
    const nativePath = !requiresInlinePayload(kind)
      ? nativeFileReference(file, options.preferFileReferences === true)
      : undefined;
    return { file, kind, nativePath };
  });

  let totalBytes = existing.reduce((sum, att) => sum + attachmentPayloadBytes(att), 0);
  for (const { file, kind, nativePath } of planned) {
    if (!nativePath && kind === 'unsupported') {
      throw new Error(`Unsupported attachment type: ${file.name}`);
    }
    if (!nativePath && file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${file.name} exceeds the 10 MB attachment limit.`);
    }
    if (!nativePath) totalBytes += file.size;
  }
  if (totalBytes > MAX_ATTACHMENTS_TOTAL_BYTES) {
    throw new Error('Attachments exceed the 25 MB combined limit.');
  }

  const converted = await Promise.all(planned.map(({ file, nativePath }) =>
    fileToAttachment(file, { ...options, nativePath })));
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

/**
 * Cheap structural revision for reconciliation work.
 *
 * Token deltas mutate the current text/thinking block in place, so rescanning
 * the complete accumulated run on every frame is unnecessary. Durable-history
 * changes still invalidate via their own reconciliation index; this revision
 * changes when a block is added/replaced or an identity-bearing tail resolves.
 */
export function liveTurnReconciliationRevision(
  turn: AssistantTurn | null,
  tailTextLength = 0,
  tailThinkingLength = 0,
): string {
  const blocks = turn?.blocks ?? [];
  const last = blocks[blocks.length - 1];
  if (!last) return '0';
  const identity = liveBlockPersistedId(last) ?? last.type;
  const status = last.type === 'tool'
    ? last.call.status
    : last.type === 'agents' ? last.group.status : '';
  // A text-only replay adds no structural block after its final delta. Flip
  // exactly once when that tail can cover the latest durable message, without
  // invalidating on every intermediate token.
  const tailReady = last.type === 'text' && tailTextLength > 0
    ? (last.text.length >= tailTextLength ? 'text-ready' : 'text-streaming')
    : last.type === 'thinking' && tailThinkingLength > 0
      ? (last.text.length >= tailThinkingLength ? 'thinking-ready' : 'thinking-streaming')
      : '';
  return `${blocks.length}:${last.type}:${identity}:${status}:${tailReady}`;
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

/** All tool_result ids already persisted to history. */
export function collectPersistedToolResultIds(messages: PersistedMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result' && b.tool_use_id) ids.add(b.tool_use_id);
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

export const collectLatestPersistedGateSignatures = collectLatestPersistedInteractivePromptSignatures;

/**
 * Immutable history-side index used by live/persisted reconciliation.
 *
 * Building this once per history refetch avoids rescanning every persisted
 * message and rebuilding large joined strings on each token frame. The live
 * side can still change every frame, but the usually much larger durable side
 * remains O(1) to reuse.
 */
export interface PersistedLiveReconciliation {
  assistantRun: PersistedMessage[];
  /** The loaded window begins after its owning user message. */
  startsMidTurn: boolean;
  precedingUserMessageId: number | null;
  persistedText: string;
  persistedThinking: string;
  persistedTextBlocks: Set<string>;
  persistedThinkingBlocks: Set<string>;
  /** Raw sizes of the newest durable assistant row for one-shot replay readiness. */
  tailTextLength: number;
  tailThinkingLength: number;
  assistantRunToolUseCount: number;
  /** All loaded tool identities/results, used for block-level dedup. */
  persistedToolUseIds: Set<string>;
  persistedToolResultIds: Set<string>;
  /** Content fallback restricted to the latest still-pending interaction. */
  pendingInteractivePromptSignatures: Set<string>;
}

export function buildPersistedLiveReconciliation(
  messages: PersistedMessage[],
  precedingUserMessageId: number | null | undefined = null,
  fallbackResultIds: Iterable<string> = [],
): PersistedLiveReconciliation {
  const latestUserIndex = latestVisibleUserIndex(messages);
  const startsMidTurn = latestUserIndex < 0 && precedingUserMessageId != null;
  const assistantRun = messages
    .slice(latestUserIndex + 1)
    .filter((message) => message.role === 'assistant');
  const persistedToolUseIds = new Set<string>();
  const persistedToolResultIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool_use' && block.id) persistedToolUseIds.add(block.id);
      }
    } else if (message.role === 'tool') {
      for (const block of message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          persistedToolResultIds.add(block.tool_use_id);
        }
      }
    }
  }
  for (const id of fallbackResultIds) {
    if (id) persistedToolResultIds.add(id);
  }

  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const persistedTextBlocks = new Set<string>();
  const persistedThinkingBlocks = new Set<string>();
  let assistantRunToolUseCount = 0;
  for (const message of assistantRun) {
    const text = getPersistedAssistantText(message);
    if (text.trim()) textParts.push(text);
    const thinking = getPersistedAssistantThinkingText(message);
    if (thinking.trim()) thinkingParts.push(thinking);
    for (const block of message.content) {
      if (block.type === 'text' && block.text) persistedTextBlocks.add(block.text);
      if (block.type === 'thinking' && block.text) persistedThinkingBlocks.add(block.text);
      if (block.type !== 'tool_use') continue;
      assistantRunToolUseCount++;
    }
  }

  return {
    assistantRun,
    startsMidTurn,
    precedingUserMessageId: precedingUserMessageId ?? null,
    persistedText: textParts.join('\n').trim(),
    persistedThinking: thinkingParts.join('\n').trim(),
    persistedTextBlocks,
    persistedThinkingBlocks,
    tailTextLength: assistantRun.length > 0
      ? getPersistedAssistantText(assistantRun[assistantRun.length - 1]).length
      : 0,
    tailThinkingLength: assistantRun.length > 0
      ? getPersistedAssistantThinkingText(assistantRun[assistantRun.length - 1]).length
      : 0,
    assistantRunToolUseCount,
    persistedToolUseIds,
    persistedToolResultIds,
    pendingInteractivePromptSignatures: collectLatestPersistedInteractivePromptSignatures(
      messages,
      persistedToolResultIds,
    ),
  };
}

function persistedLiveReconciliation(
  history: PersistedMessage[] | PersistedLiveReconciliation,
  precedingUserMessageId?: number | null,
): PersistedLiveReconciliation {
  return Array.isArray(history)
    ? buildPersistedLiveReconciliation(history, precedingUserMessageId)
    : history;
}

/** Live blocks NOT yet represented in persisted history (dedup by id or prompt signature). */
export function visibleLiveBlocks(
  blocks: StreamBlock[],
  persistedIds: Set<string>,
  persistedInteractivePromptSignatures: Set<string> = new Set(),
  persistedResultIds: Set<string> = new Set(),
  preferCompleteLiveRun = false,
  reconciliation?: PersistedLiveReconciliation,
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
    && !reconciliation?.startsMidTurn
  ) return blocks;
  // A cold replay can begin inside the durable tail and then continue with new
  // events. In that case neither "all live" nor "all persisted" is canonical.
  // Cut the proven persisted prefix at its last ordered identity/text match and
  // append only the genuinely new live suffix after the durable transcript.
  let persistedOverlapPrefixEnd = -1;
  if (!preferCompleteLiveRun && reconciliation?.startsMidTurn) {
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      const id = liveBlockPersistedId(block);
      const signature = liveBlockPersistedSignature(block);
      const matchesPersisted = Boolean(
        (id && persistedIds.has(id))
        || (
          signature
          && persistedInteractivePromptSignatures.has(signature)
        )
        || (
          block.type === 'text'
          && reconciliation.persistedTextBlocks.has(block.text)
        )
        || (
          block.type === 'thinking'
          && reconciliation.persistedThinkingBlocks.has(block.text)
        )
      );
      if (matchesPersisted) {
        persistedOverlapPrefixEnd = index;
        continue;
      }
      // A new identity is a hard chronological boundary. Do not let repeated
      // text later in the fresh suffix be mistaken for old durable content.
      if (id) break;
    }
  }
  return blocks.filter((b, index) => {
    if (index <= persistedOverlapPrefixEnd) return false;
    if (b.type === 'agents') {
      if (b.group.groupId.startsWith('tasks-wave-')) return false;
      if (preferCompleteLiveRun) return true;
      const toolUseId = b.group.toolUseId;
      // Once the completed group and its result are durable, the persisted
      // AgentsGroupBlock is canonical at the spawn tool's chronological
      // position. Keeping the accumulated live copy would move it to the very
      // end of the transcript, potentially below a later plan/card.
      if (
        b.group.status === 'completed'
        && toolUseId
        && persistedIds.has(toolUseId)
        && persistedResultIds.has(toolUseId)
      ) return false;
      // Task waves are already represented by TaskExecutionBlock. For genuine
      // subagents, the rich live card is canonical while it exists, even if
      // the parent tool_use has already checkpointed into history.
      return true;
    }
    if (
      b.type === 'tool'
      && (
        (hasTaskRun && b.call.name === 'execute_tasks')
        || (liveAgentToolUseIds.has(b.call.id)
          && ['spawn_agent', 'spawn_agents', 'resume_agent'].includes(b.call.name))
      )
    ) return false;
    // When the accumulated live buffer demonstrably covers the persisted
    // assistant tail, it is the canonical rendering for this in-flight run.
    // Filtering its persisted tool ids individually would punch holes in the
    // sequence (tools disappear while their preceding text moves to the end).
    if (preferCompleteLiveRun) return true;
    const id = liveBlockPersistedId(b);
    if (id && persistedIds.has(id)) return false;
    const signature = liveBlockPersistedSignature(b);
    return !(signature && persistedInteractivePromptSignatures.has(signature));
  });
}

export function isLiveTurnDuplicatedInHistory(
  turn: AssistantTurn | null,
  history: PersistedMessage[] | PersistedLiveReconciliation,
  persistedIds?: Set<string>,
  precedingUserMessageId?: number | null,
): boolean {
  if (!turn || turn.blocks.length === 0) return false;
  const reconciliation = persistedLiveReconciliation(history, precedingUserMessageId);
  if (reconciliation.assistantRun.length === 0) return false;
  const effectivePersistedIds = persistedIds ?? reconciliation.persistedToolUseIds;

  const liveText = getCurrentTurnText(turn).trim();
  const persistedText = reconciliation.persistedText;
  const liveThinking = getCurrentTurnThinkingText(turn).trim();
  const persistedThinking = reconciliation.persistedThinking;
  let checkedText = false;
  let checkedThinking = false;

  for (const block of turn.blocks) {
    // Running agents remain live-canonical. A completed group whose tool result
    // is already durable is fully reconstructable in persisted history and
    // must not keep the accumulated live run appended after newer content.
    if (block.type === 'agents') {
      const id = block.group.toolUseId;
      if (
        block.group.status === 'completed'
        && id
        && effectivePersistedIds.has(id)
        && reconciliation.persistedToolResultIds.has(id)
      ) continue;
      return false;
    }
    if (block.type === 'text') {
      if (!checkedText) {
        if (
          !liveText
          || (
            reconciliation.startsMidTurn
              ? !persistedText.endsWith(liveText)
              : persistedText !== liveText
          )
        ) return false;
        checkedText = true;
      }
      continue;
    }
    if (block.type === 'thinking') {
      if (!checkedThinking) {
        if (
          !liveThinking
          || (
            reconciliation.startsMidTurn
              ? !persistedThinking.endsWith(liveThinking)
              : persistedThinking !== liveThinking
          )
        ) return false;
        checkedThinking = true;
      }
      continue;
    }

    const id = liveBlockPersistedId(block);
    if (id) {
      if (effectivePersistedIds.has(id)) continue;
      const signature = liveBlockPersistedSignature(block);
      if (
        signature
        && reconciliation.pendingInteractivePromptSignatures.has(signature)
      ) continue;
      return false;
    }

    // activity/task_run are live-only visualizations; keep them visible unless
    // a future persisted identity can prove they are duplicates too.
    return false;
  }

  return true;
}

function latestVisibleUserIndex(messages: PersistedMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'user' && !message.isMeta && !isToolImagePlumbing(message)) return index;
  }
  return -1;
}

/**
 * True when `currentTurn` still contains the complete assistant run that the
 * latest persisted history only checkpoints a prefix of. This is the normal
 * state after switching away from and back to a busy session: the GET becomes
 * newer while the per-session live buffer remains complete.
 */
export function liveTurnCoversPersistedAssistantRun(
  turn: AssistantTurn | null,
  history: PersistedMessage[] | PersistedLiveReconciliation,
  precedingUserMessageId?: number | null,
): boolean {
  if (!turn || turn.blocks.length === 0) return false;
  const reconciliation = persistedLiveReconciliation(history, precedingUserMessageId);
  if (reconciliation.assistantRun.length === 0) return false;
  const persistedText = reconciliation.persistedText;
  const persistedThinking = reconciliation.persistedThinking;
  const liveText = getCurrentTurnText(turn).trim();
  const liveThinking = getCurrentTurnThinkingText(turn).trim();
  if (
    persistedText
    && (
      reconciliation.startsMidTurn
        ? !liveText.includes(persistedText)
        : !liveText.startsWith(persistedText)
    )
  ) return false;
  if (
    persistedThinking
    && (
      reconciliation.startsMidTurn
        ? !liveThinking.includes(persistedThinking)
        : !liveThinking.startsWith(persistedThinking)
    )
  ) return false;

  const liveIds = new Set<string>();
  const liveSignatures = new Set<string>();
  for (const block of turn.blocks) {
    const id = liveBlockPersistedId(block);
    if (id) liveIds.add(id);
    const signature = liveBlockPersistedSignature(block);
    if (signature) liveSignatures.add(signature);
  }
  for (const message of reconciliation.assistantRun) {
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      if (block.id && liveIds.has(block.id)) continue;
      const signature = persistedInteractivePromptSignature(block.name, block.input);
      if (
        signature
        && reconciliation.pendingInteractivePromptSignatures.has(signature)
        && liveSignatures.has(signature)
      ) continue;
      return false;
    }
  }

  return Boolean(
    persistedText
    || persistedThinking
    || reconciliation.assistantRunToolUseCount > 0
  );
}

/**
 * Hide only the checkpointed assistant groups belonging to the latest visible
 * user turn. The complete live run is rendered in their place, preserving the
 * original text/tool order while an active session continues streaming.
 */
export function suppressLatestPersistedAssistantRun(
  groups: VisualGroup[],
  precedingUserMessageId?: number | null,
): VisualGroup[] {
  let latestUserGroup = -1;
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index];
    if (
      group.kind === 'user'
      && !group.message.isMeta
      && !isToolImagePlumbing(group.message)
    ) {
      latestUserGroup = index;
      break;
    }
  }
  if (latestUserGroup < 0) {
    if (precedingUserMessageId == null) return groups;
    const filtered = groups.filter((group) => group.kind !== 'assistant');
    return filtered.length === groups.length ? groups : filtered;
  }
  const filtered = groups.filter((group, index) => index <= latestUserGroup || group.kind !== 'assistant');
  return filtered.length === groups.length ? groups : filtered;
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

    // Meta inputs are model/runtime plumbing. They remain persisted and are
    // still available to the runner and diagnostics, but must never be shown
    // as if the user typed them.
    if (msg.role === 'user' && msg.isMeta) continue;

    if (msg.role === 'user') {
      flushPending();
      groups.push({
        kind: 'user',
        message: msg,
        // Optimistic ids are client-only. Do not expose fork/rollback or lazy
        // attachment endpoints until the authoritative DB row replaces them.
        messageId: row?.optimistic ? undefined : row?.id,
        usage: row,
      });
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
