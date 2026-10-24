import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
const mocks = vi.hoisted(() => ({ review: vi.fn(), intent: vi.fn(), evidence: vi.fn() }));
vi.mock('@mcp/services/services/review-session-snapshots.js', () => ({ reviewSessionSnapshots: mocks.review }));
vi.mock('@mcp/code-agent/sessions/session-intent.js', () => ({ buildSessionIntent: mocks.intent }));
vi.mock('@mcp/code-agent/core/review-evidence.js', () => ({ buildVerifyEvidence: mocks.evidence, formatVerifyEvidence: () => '' }));
import { buildSelfReviewTool } from '../self-review.js';
import { buildReviewSubordinateTool } from '@mcp/company/tools/review-subordinate.js';

const sessionId = '00000000-0000-4000-8000-000000000001';
function selfReview() {
  return buildSelfReviewTool({ settingsDbHandle: {} as never, sessionStore: {} as never, sessionId: sessionId as never, projectRoot: 'D:\\fixture' });
}
beforeEach(() => {
  mocks.review.mockReset().mockResolvedValue({ ok: true, pendingHunks: 0, findings: [] });
  mocks.intent.mockReset().mockResolvedValue('task');
  mocks.evidence.mockReset().mockResolvedValue(null);
});
describe('review tool cancellation wiring', () => {

  it('forwards the self-review invocation signal', async () => {
    const signal = new AbortController().signal;
    expect((await selfReview().handler({}, { signal } as ToolContext)).isError).not.toBe(true);
    expect(mocks.review.mock.calls[0][2]).toMatchObject({ signal, intent: 'task' });
  });
  it('does not continue preparing a review after cancellation during intent loading', async () => {
    const controller = new AbortController();
    mocks.intent.mockImplementation(async () => { controller.abort(new Error('stop')); return 'task'; });
    await expect(selfReview().handler({}, { signal: controller.signal } as ToolContext)).rejects.toThrow('stop');
    expect(mocks.evidence).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it('rejects an oversized or malformed focus before loading session state', async () => {
    for (const focus of [100, 'x'.repeat(4001)]) {
      expect((await selfReview().handler({ focus }, {} as ToolContext)).isError).toBe(true);
    }
    expect(mocks.intent).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it('forwards the Company invocation signal to the same review service', async () => {
    const signal = new AbortController().signal;
    const tool = buildReviewSubordinateTool({ listSubordinates: () => [{ agentRunId: 'child', coderSessionId: sessionId, projectIds: [1] }] } as never,
      { settingsDbHandle: {} as never, sessionStore: {} as never, getProjectRoot: () => 'D:\\fixture' });
    expect((await tool.handler({ agent_run_id: 'child' }, { signal } as ToolContext)).isError).not.toBe(true);
    expect(mocks.review.mock.calls[0][2]).toMatchObject({ signal });
  });
});
