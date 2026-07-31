import { describe, expect, it, vi } from 'vitest';
import { IdleController } from '@mcp/company/services/IdleController.js';

describe('IdleController explicit finalization', () => {
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
