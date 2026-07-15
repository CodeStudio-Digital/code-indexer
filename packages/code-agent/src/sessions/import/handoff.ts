import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { CompactionSummaryV3, SummarizeSpanV3Input } from '@mcp/code-agent/core/summarizer-v3.js';
import type { ExternalSessionDocument } from './types.js';

const FIELD_LIMIT = 4_000;
const ITEM_LIMIT = 1_200;

function clip(value: string, limit = ITEM_LIMIT): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

function messageText(message: AgentMessage): string {
  return message.content.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'tool_use') return `[tool ${block.name}]`;
    if (block.type === 'tool_result') return `[tool result ${block.tool_use_id}]`;
    if (block.type === 'image') return `[image ${block.mediaType}]`;
    if (block.type === 'document') return `[attachment ${block.name}]`;
    return '';
  }).filter(Boolean).join('\n');
}

function usefulTail(document: ExternalSessionDocument, limit = 36): AgentMessage[] {
  return document.messages
    .map((entry) => entry.message)
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-limit)
    .map((message) => ({
      ...message,
      content: message.content.filter((block) => block.type === 'text' || block.type === 'image' || block.type === 'document'),
    }))
    .filter((message) => message.content.length > 0);
}

export function importSummaryInput(document: ExternalSessionDocument): SummarizeSpanV3Input {
  return {
    previousResume: document.source_summary
      ? `Summary supplied by ${document.candidate.source}:\n${document.source_summary.slice(0, 12_000)}`
      : null,
    messages: usefulTail(document),
    liveState: null,
  };
}

export function buildDeterministicImportSummary(document: ExternalSessionDocument): CompactionSummaryV3 {
  const userTexts = document.messages
    .filter((entry) => entry.message.role === 'user')
    .map((entry) => clip(messageText(entry.message)))
    .filter(Boolean);
  const assistantTexts = document.messages
    .filter((entry) => entry.message.role === 'assistant')
    .map((entry) => clip(messageText(entry.message)))
    .filter(Boolean);
  const lastRequest = userTexts.at(-1) ?? 'Continue the imported work.';
  const sourceSummary = clip(document.source_summary ?? '', FIELD_LIMIT);
  const completed = assistantTexts.slice(-5);
  const cwd = document.candidate.cwd;
  const origin = document.candidate.source === 'claude-code' ? 'Claude Code' : 'Codex';
  const summary = sourceSummary || [
    `Imported snapshot from ${origin}.`,
    ...assistantTexts.slice(-3),
  ].join(' ');

  return {
    version: 3,
    chapter: {
      title: `Imported from ${origin}`,
      summary: clip(summary, FIELD_LIMIT),
      user_requests: userTexts.slice(-6),
      decisions: sourceSummary ? [`Preserve and continue from the source summary: ${sourceSummary}`] : [],
      work_completed: completed,
      files: [],
      open_issues: [`Validate remaining work from the last request: ${lastRequest}`],
      resolved_issues: [],
    },
    resume: {
      objective: clip(userTexts[0] ?? lastRequest),
      current_focus: lastRequest,
      constraints: [
        'This is a one-way imported snapshot; source runtime state, permissions and credentials are unavailable.',
        ...(cwd ? [`Imported working directory: ${cwd}`] : []),
      ],
      pending_tasks: [`Continue from the last imported request: ${lastRequest}`],
      next_step: `Inspect the current project state, then continue: ${lastRequest}`,
    },
  };
}
