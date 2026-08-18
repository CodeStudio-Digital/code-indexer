import { describe, expect, it } from 'vitest';
import {
  hasResumableInteractiveToolUse,
  isResumableInteractiveTool,
  RESUMABLE_INTERACTIVE_TOOLS,
} from '../interactive-tools.js';
import type { AgentMessage } from '@mcp/provider-sdk';

const assistantWith = (name: string): AgentMessage => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'toolu_1', name, input: {} }],
}) as AgentMessage;

describe('RESUMABLE_INTERACTIVE_TOOLS', () => {
  it('checkpoints decision_gate so a reload can still answer it', () => {
    // It was reader-only for a while: the card lived in the live buffer alone,
    // so any reload lost it and POST /decide answered 404.
    expect(isResumableInteractiveTool('decision_gate')).toBe(true);
    expect(hasResumableInteractiveToolUse(assistantWith('decision_gate'))).toBe(true);
  });

  it('covers every prompt the dashboard renders as an interactive card', () => {
    for (const name of [
      'submit_plan', 'submit_tasks', 'task_list', 'ask_user',
      'submit_spec', 'submit_specification_to_master', 'decision_gate',
    ]) {
      expect(RESUMABLE_INTERACTIVE_TOOLS.has(name)).toBe(true);
    }
  });

  it('excludes tools whose checkpoint would render as a stuck spinner', () => {
    // A PermissionGate pause or budget ask has no approve affordance once
    // persisted as a plain dangling tool_use.
    expect(isResumableInteractiveTool('write_file')).toBe(false);
    expect(isResumableInteractiveTool('run_command')).toBe(false);
    expect(isResumableInteractiveTool('execute_tasks')).toBe(false);
  });

  it('ignores assistant messages that park on nothing interactive', () => {
    expect(hasResumableInteractiveToolUse(assistantWith('read_file'))).toBe(false);
    expect(hasResumableInteractiveToolUse(
      { role: 'assistant', content: 'plain' } as unknown as AgentMessage,
    )).toBe(false);
  });
});
