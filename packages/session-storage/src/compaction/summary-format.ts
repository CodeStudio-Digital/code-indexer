import type { AgentMessage } from '@mcp/provider-sdk';
import type { CompactionResumeV3, CompactionSummaryV3, CompactionChapterV3 } from './summary-types.js';

const SUMMARY_PREFIX_V3 = '[auto-compacted summary of older turns]';

function renderedSummaryText(message: AgentMessage): string | null {
  const text = message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return text.trimStart().startsWith(SUMMARY_PREFIX_V3) ? text : null;
}

/** Remove already-rendered summaries from the new span and recover the newest as prior state. */
export function separatePreviousResumeV3(
  messages: AgentMessage[],
  explicitPrevious?: CompactionResumeV3 | string | null,
): { messages: AgentMessage[]; previousResume: CompactionResumeV3 | string | null } {
  const clean: AgentMessage[] = [];
  let recovered: string | null = null;
  for (const message of messages) {
    const prior = renderedSummaryText(message);
    if (prior !== null) {
      recovered = prior;
      continue;
    }
    clean.push(message);
  }
  return {
    messages: clean,
    previousResume: explicitPrevious !== undefined ? explicitPrevious : recovered,
  };
}

/** Compact resume injected into model context; prefix/tags stay V2-compatible. */
export function renderResumeV3(summary: CompactionSummaryV3 | CompactionResumeV3): string {
  const resume = 'resume' in summary ? summary.resume : summary;
  const lines: string[] = [SUMMARY_PREFIX_V3, ''];
  const block = (tag: string, body: string): void => {
    if (!body.trim()) return;
    lines.push(`<${tag}>`, body.trimEnd(), `</${tag}>`, '');
  };
  if (resume.active_goal) block('active_goal', resume.active_goal);
  if (resume.objective) block('primary_request', resume.objective);
  if (resume.current_focus || resume.next_step) {
    block('current_focus', [
      resume.current_focus ? `work: ${resume.current_focus}` : '',
      resume.next_step ? `next: ${resume.next_step}` : '',
    ].filter(Boolean).join('\n'));
  }
  if (resume.constraints.length > 0) {
    block('constraints', resume.constraints.map((item) => `- ${item}`).join('\n'));
  }
  if (resume.pending_tasks.length > 0) {
    block('pending_tasks', resume.pending_tasks.map((item) => `- ${item}`).join('\n'));
  }
  while (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** Human-readable chapter text for persistence/search/UI fallbacks. */
export function renderChapterV3(summary: CompactionSummaryV3 | CompactionChapterV3): string {
  const chapter = 'chapter' in summary ? summary.chapter : summary;
  const lines: string[] = [`# ${chapter.title || 'Conversation chapter'}`];
  const section = (title: string, body: string): void => {
    if (!body.trim()) return;
    lines.push('', `## ${title}`, '', body.trimEnd());
  };
  section('Summary', chapter.summary);
  section('User requests', chapter.user_requests.map((item) => `- ${item}`).join('\n'));
  section('Decisions', chapter.decisions.map((item) => `- ${item}`).join('\n'));
  section('Work completed', chapter.work_completed.map((item) => `- ${item}`).join('\n'));
  section('Files', chapter.files.map((file) => `- \`${file.path}\` — ${file.state}`).join('\n'));
  section('Open issues', chapter.open_issues.map((item) => `- ${item}`).join('\n'));
  section('Resolved issues', chapter.resolved_issues.map((item) => `- ${item}`).join('\n'));
  return lines.join('\n');
}
