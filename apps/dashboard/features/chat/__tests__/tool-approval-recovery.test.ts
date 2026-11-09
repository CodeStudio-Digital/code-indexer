import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ToolApprovalCard } from '../messages/ToolApprovalCard.js';
import type { PendingToolApproval, SessionState, StreamBlock, UpdateSession } from '../../../hooks/agent-stream/types.js';
import { createEventHandlers } from '../../../hooks/agent-stream/handlers.js';
import { parseToolApprovalRecovery, toolApprovalResponseBody, toolApprovalVerdict } from '../../../hooks/agent-stream/tool-approval-response.js';

vi.mock('react-i18next', async (importOriginal: () => Promise<typeof import('react-i18next')>) => ({
  ...await importOriginal(), useTranslation: () => ({ t: (key: string) => key }),
}));

const recovery = { fingerprint: 'host-set:two', incidents: [
  { toolUseId: 'old-command', toolName: 'run_command', argsSummary: 'first command && inspect <state>' },
  { toolUseId: 'old-edit', toolName: 'edit_file', argsSummary: 'second edit' },
] };
const recoverable: PendingToolApproval = { toolUseId: 'new-action', toolName: 'run_command', argsSummary: 'new exact command',
  riskClass: 'execute', approvalKind: 'outcome_recovery', receivedAt: 1, recovery };

describe('uncertain outcome recovery approval', () => {
  it.each([false, true])('shows the risk and excludes persistent grants, compact=%s', compact => {
    const approval: PendingToolApproval = { toolUseId: 'new-action', toolName: 'run_command', argsSummary: 'truncated preview',
      input: { command: 'inspect-current-state-with-exact-arguments' }, riskClass: 'execute',
      approvalKind: 'outcome_recovery', receivedAt: Date.now() };
    const html = renderToStaticMarkup(createElement(ToolApprovalCard, { approvals: [approval], compact,
      onRespond: async () => {} }));
    expect(html).toContain('approval.outcomeRecoveryWarning');
    expect(html).toContain('approval.executeOnce');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('approval.alwaysAllow');
    expect(html).toContain('inspect-current-state-with-exact-arguments');
  });

  it.each([false, true])('lists the complete review set without preselecting it, compact=%s', compact => {
    const html = renderToStaticMarkup(createElement(ToolApprovalCard, { approvals: [recoverable], compact,
      onRespond: async () => {} }));
    expect(html).toContain('old-command');
    expect(html).toContain('old-edit');
    expect(html).toContain('first command &amp;&amp; inspect &lt;state&gt;');
    expect(html).toContain('second edit');
    expect(html).toContain('approval.recoveryReviewExplanation');
    expect(html).toContain('approval.recoveryReviewLabel');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('checked=');
    expect(html).toContain('approval.executeOnce');
    expect(html).not.toContain('approval.executeAndResumeMode');
    expect(html).not.toContain('approval.alwaysAllow');
  });

  it('submits a review only with approval, the explicit checkbox and the exact host fingerprint', () => {
    const verdict = toolApprovalVerdict(recoverable, true, { note: ' checked locally ', alwaysAllow: true, recoveryReviewed: true });
    expect(toolApprovalResponseBody(recoverable.toolUseId, verdict)).toEqual({
      tool_use_id: 'new-action', approved: true, note: 'checked locally', always_allow: undefined,
      recovery_reviewed: true, recovery_fingerprint: 'host-set:two',
    });
  });

  it.each([
    { approved: false, checked: true, available: true },
    { approved: true, checked: false, available: true },
    { approved: true, checked: true, available: false },
  ])('does not record a review or persistent grant for $approved/$checked/$available', ({ approved, checked, available }) => {
    const approval = { ...recoverable, recovery: available ? recovery : undefined };
    const verdict = toolApprovalVerdict(approval, approved, { note: '', alwaysAllow: true, recoveryReviewed: checked });
    const body = toolApprovalResponseBody(approval.toolUseId, verdict);
    expect(body).not.toHaveProperty('recovery_reviewed');
    expect(body).not.toHaveProperty('recovery_fingerprint');
    expect(body.always_allow).toBeUndefined();
    expect(body.approved).toBe(approved);
  });

  it('does not serialize stale review fields on a denial', () => {
    const body = toolApprovalResponseBody('new-action', { approved: false, alwaysAllow: true,
      recoveryReviewed: true, recoveryFingerprint: 'host-set:two' });
    expect(body).not.toHaveProperty('recovery_reviewed');
    expect(body).not.toHaveProperty('recovery_fingerprint');
    expect(body.always_allow).toBeUndefined();
  });

  it.each(['standard', 'database_write'] as const)('preserves the existing %s session grant independently of recovery', approvalKind => {
    const verdict = toolApprovalVerdict({ ...recoverable, approvalKind }, true,
      { note: '', alwaysAllow: true, recoveryReviewed: true });
    expect(toolApprovalResponseBody('new-action', verdict)).toEqual({
      tool_use_id: 'new-action', approved: true, note: undefined, always_allow: true,
    });
  });

  it.each([
    null, {}, { fingerprint: '', incidents: recovery.incidents },
    { fingerprint: 'host-set:two', incidents: [] },
    { fingerprint: 'host-set:two', incidents: [...recovery.incidents, { toolUseId: 'old-edit' }] },
    { fingerprint: 'host-set:two', incidents: [...recovery.incidents, { toolUseId: '' }] },
    { fingerprint: 'host-set:two', incidents: [...recovery.incidents, { toolUseId: 'bad', argsSummary: 42 }] },
  ])('rejects the entire malformed review set %#', invalid => {
    expect(parseToolApprovalRecovery(invalid)).toBeUndefined();
  });

  it('preserves opaque fingerprints and optional historical details without inference', () => {
    expect(parseToolApprovalRecovery({ fingerprint: 'opaque:future-format', incidents: [{ toolUseId: 'legacy-only-id' }] }))
      .toEqual({ fingerprint: 'opaque:future-format', incidents: [{ toolUseId: 'legacy-only-id' }] });
  });

  it('replays the current host incident set consistently in the inline card and pending banner', () => {
    const blocks: StreamBlock[] = [{ type: 'tool', call: { id: 'parent', name: 'code_exec', status: 'running' } }];
    let state = { pendingApprovals: [], activeProcesses: [] } as unknown as SessionState;
    const updateSession: UpdateSession = (_sid, patch) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    };
    const handlers = createEventHandlers({ sid: 'session', blocks, toolIndex: new Map([['parent', 0]]),
      flush: vi.fn(), flushNow: vi.fn(), updateSession });
    const emit = (data: object) => handlers.tool_approval_request({ ...recoverable, parentToolUseId: 'parent', ...data }, 'tool_approval_request');
    emit({});
    emit({});
    expect(state.pendingApprovals).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ call: { approvals: [{ recovery }] } });
    if (blocks[0].type !== 'tool') throw new Error('expected tool');
    expect(blocks[0].call.approvals).toHaveLength(1);
    const revised = { fingerprint: 'host-set:one', incidents: [recovery.incidents[1]] };
    emit({ recovery: revised });
    expect(state.pendingApprovals[0].recovery).toEqual(revised);
    expect(blocks[0].call.approvals?.[0].recovery).toEqual(revised);
    emit({ recovery: { fingerprint: 'incomplete', incidents: [{ toolUseId: '' }] } });
    expect(state.pendingApprovals[0].recovery).toBeUndefined();
    expect(blocks[0].call.approvals?.[0].recovery).toBeUndefined();
    emit({ approvalKind: 'standard', recovery });
    expect(state.pendingApprovals[0].recovery).toBeUndefined();
  });
});
