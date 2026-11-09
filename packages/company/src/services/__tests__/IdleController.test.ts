import { describe, expect, it, vi } from 'vitest';
import { IdleController } from '@mcp/company/services/IdleController.js';

describe('IdleController explicit finalization', () => {
  it.each([null, '2026-11-05T00:00:00.000Z', '2026-11-05T00:59:59.000Z'])(
    'reports successful autonomous completion without a false failure (last user: %s)', lastUserMessageAt => {
      const publish = vi.fn(), markEnded = vi.fn();
      const controller = new IdleController({
        ctx: { isAborted: false, isBusEnded: false, companyFiles: { updateSessionStatus: vi.fn().mockResolvedValue(undefined) } },
        bus: { publish, markEnded }, subordinates: { runningCount: 0 },
        master: { hasEnded: true, endedWithError: null, endedAt: '2026-11-05T01:00:00.000Z', lastUserMessageAt },
        consumeMasterShouldContinue: () => false, onAutoContinue: vi.fn(),
      } as never);
      controller.onMasterEnded();
      expect(publish).toHaveBeenCalledWith('session_idle', {
        reason: 'waiting_for_input', endedAt: '2026-11-05T01:00:00.000Z', unexpected: false,
      });
      expect(markEnded).not.toHaveBeenCalled();
      controller.dispose();
    });

  it('preserves the actual runner failure even immediately after a user message', () => {
    const publish = vi.fn();
    const controller = new IdleController({
      ctx: { isAborted: false, isBusEnded: false, companyFiles: { updateSessionStatus: vi.fn().mockResolvedValue(undefined) } },
      bus: { publish, markEnded: vi.fn() }, subordinates: { runningCount: 0 },
      master: { hasEnded: true, endedWithError: 'provider disconnected', endedAt: '2026-11-05T01:00:00.000Z', lastUserMessageAt: '2026-11-05T01:00:00.000Z' },
      consumeMasterShouldContinue: () => false, onAutoContinue: vi.fn(),
    } as never);
    controller.onMasterEnded();
    expect(publish).toHaveBeenCalledWith('session_idle', {
      reason: 'master_error', errorDetail: 'provider disconnected', endedAt: '2026-11-05T01:00:00.000Z', unexpected: true,
    });
    controller.dispose();
  });

  it('keeps ordinary completed turns idle and available to the scheduler/inbox without an idle-timeout shutdown', async () => {
    vi.useFakeTimers();
    try {
      const updateSessionStatus = vi.fn().mockResolvedValue(undefined); const markEnded = vi.fn();
      const controller = new IdleController({ ctx: { isAborted: false, isBusEnded: false, isFinalized: false, companyFiles: { updateSessionStatus } }, bus: { publish: vi.fn(), markEnded }, subordinates: { runningCount: 0 }, master: { hasEnded: true, endedWithError: null }, consumeMasterShouldContinue: () => false, onAutoContinue: vi.fn() } as never);
      controller.onMasterEnded(); await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(updateSessionStatus).toHaveBeenCalledWith('idle'); expect(markEnded).not.toHaveBeenCalled(); controller.dispose();
    } finally { vi.useRealTimers(); }
  });
  it('ends the bus without downgrading a finalized session to paused', () => {
    const updateSessionStatus = vi.fn().mockResolvedValue(undefined);
    const publish = vi.fn();
    const markEnded = vi.fn();
    const consumeMasterShouldContinue = vi.fn(() => false);
    const controller = new IdleController({
      ctx: {
        isAborted: false,
        isBusEnded: false,
        isFinalized: true,
        companyFiles: { updateSessionStatus },
      },
      bus: { publish, markEnded },
      subordinates: { runningCount: 0 },
      onAutoContinue: vi.fn(),
      consumeMasterShouldContinue,
      master: {
        hasEnded: true,
        endedWithError: null,
        endedAt: new Date().toISOString(),
        lastUserMessageAt: new Date().toISOString(),
      },
    } as never);

    controller.onMasterEnded();

    expect(markEnded).toHaveBeenCalledWith('done', { reason: 'finalized' });
    expect(updateSessionStatus).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalledWith('session_idle', expect.anything());
    expect(consumeMasterShouldContinue).not.toHaveBeenCalled();
  });
});
