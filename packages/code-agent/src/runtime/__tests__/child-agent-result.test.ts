/**
 * The result format E6 returns for child agents: text with a header per
 * child, changed files, a question, then the answer. A wait spills a long
 * answer (the text keeps the head and points at get_tool_output); a
 * background notice is bounded for the mailbox and points at read_chat.
 */
import { describe, expect, it } from 'vitest';
import { CHILD_AGENT_NOTICE_TEXT_MAX, formatChildAgentItem, formatChildAgentNotice, formatChildAgentWait } from '../child-agent-result.js';

describe('child-agent result format', () => {
  it('formats a finished child with its files and whole answer', () => {
    expect(formatChildAgentItem({ chatId: 'c1', status: 'completed', reason: 'completed', changedFiles: ['src/a.ts', 'src/b.ts'],
      finalText: 'Fixed the bug.' })).toBe([
      'Chat c1: completed',
      'Changed files: src/a.ts, src/b.ts',
      'Answer:',
      'Fixed the bug.',
    ].join('\n'));
  });

  it('keeps the spilled head of a long answer and points at the tool output', () => {
    const text = formatChildAgentItem({ chatId: 'c1', status: 'cut_off', reason: 'watchdog', finalText: 'head', outputId: 'out-7' });
    expect(text).toBe('Chat c1: cut_off (watchdog)\nAnswer:\nhead\n[Answer truncated; the full answer is tool output out-7, read it with get_tool_output.]');
  });

  it('formats questions, approvals and a timed-out wait', () => {
    const result = formatChildAgentWait({ outcome: 'timeout', items: [
      { chatId: 'c1', status: 'question', question: { requestId: 'q1', text: 'Which branch?' } },
      { chatId: 'c2', status: 'awaiting_approval' },
      { chatId: 'c3', status: 'running' },
    ] });
    expect(result).toBe([
      'Wait timed out; the children below keep running unless stopped.',
      'Chat c1: question\nQuestion (request q1): Which branch?',
      'Chat c2: awaiting_approval',
      'Chat c3: running',
    ].join('\n\n'));
  });

  it('bounds a completion notice and points at read_chat for the rest', () => {
    const notice = formatChildAgentNotice({ chatId: 'c1', status: 'completed', finalText: 'y'.repeat(CHILD_AGENT_NOTICE_TEXT_MAX + 100) });
    expect(notice.startsWith('A child agent you started without waiting has finished.\nChat c1: completed\nAnswer:\n')).toBe(true);
    expect(notice).toContain(`[Answer truncated at ${CHILD_AGENT_NOTICE_TEXT_MAX} of ${CHILD_AGENT_NOTICE_TEXT_MAX + 100} characters; read the full answer with read_chat c1.]`);
    expect(notice.length).toBeLessThan(CHILD_AGENT_NOTICE_TEXT_MAX + 300);
    expect(formatChildAgentNotice({ chatId: 'c2', status: 'failed', reason: 'start_unknown' }))
      .toBe('A child agent you started without waiting has finished.\nChat c2: failed (start_unknown)');
    expect(formatChildAgentNotice({ chatId: 'c3', status: 'aborted', reason: 'stopped_by_user', changedFiles: ['src/half.ts'] }))
      .toBe('A child agent you started without waiting was stopped by the user.\nChat c3: aborted (stopped_by_user)\nChanged files: src/half.ts');
  });
});
