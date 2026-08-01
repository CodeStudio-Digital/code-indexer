/**
 * Regression for the composer's "inject on next turn" queue.
 *
 * A message can arrive after Executing has already flushed the pending buffer
 * for the current provider call. If that call returns a text-only final answer,
 * CleanFinish must loop through Executing once more instead of terminating with
 * the newly accepted message still stranded on the runner.
 */
import { describe, expect, it } from 'vitest';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class ControlledProvider implements ChatProvider {
  readonly name = 'pending-message-test';
  model = 'pending-message-test-1';
  calls = 0;
  readonly requests: string[] = [];
  readonly firstTurnStarted = deferred();
  readonly releaseFirstTurn = deferred();
  onRequest?: (call: number) => void;

  setModel(model: string): void {
    this.model = model;
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
    this.calls++;
    this.requests.push(JSON.stringify(request.messages));
    this.onRequest?.(this.calls);

    if (this.calls === 1) {
      yield { type: 'text_delta', text: 'first answer' };
      this.firstTurnStarted.resolve();
      await this.releaseFirstTurn.promise;
    } else {
      yield { type: 'text_delta', text: 'queued answer' };
    }
    yield { type: 'done' };
  }
}

describe('CoderRunner pending user-message liveness', () => {
  it('runs another Executing turn when a message arrives during the final provider call', async () => {
    const provider = new ControlledProvider();
    const runner = new CoderRunner({
      provider,
      registry: new ToolRegistry(),
      systemPrompt: 'test',
      toolContext: { cwd: process.cwd(), projectName: 'pending-message-test' },
    });
    const userBoundaries: number[][] = [];
    const executionOrder: string[] = [];
    provider.onRequest = (call) => executionOrder.push(`provider:${call}`);
    runner.on('user_message_boundary', ({ roundMessageIds }) => {
      userBoundaries.push(roundMessageIds);
      executionOrder.push(`boundary:${roundMessageIds.join(',')}`);
    });

    runner.pushUserMessage('initial message', { roundMessageId: 11 });
    const running = runner.run();

    await provider.firstTurnStarted.promise;
    runner.pushPendingUserContent([
      { type: 'text', text: 'queued during final turn' },
      {
        type: 'document',
        name: 'notes.txt',
        mediaType: 'text/plain',
        text: 'attachment details',
      },
    ], { roundMessageId: 22 });
    provider.releaseFirstTurn.resolve();

    const result = await running;

    expect(result.reason).toBe('completed');
    expect(provider.calls).toBe(2);
    expect(provider.requests[1]).toContain('queued during final turn');
    expect(provider.requests[1]).toContain('attachment details');
    expect(runner.turn).toBe(2);
    expect(runner.hasPendingUserMessages()).toBe(false);
    expect(runner.roundMessageId).toBe(22);
    expect(userBoundaries).toEqual([[11], [22]]);
    expect(executionOrder.indexOf('boundary:22')).toBeLessThan(
      executionOrder.indexOf('provider:2'),
    );
  });

  it('refreshes the live exact-file roots used by filesystem tools', () => {
    const externalRoots: Array<{
      id: string;
      seq?: number;
      rootPath: string;
      access: 'read' | 'write';
    }> = [];
    const runner = new CoderRunner({
      provider: new ControlledProvider(),
      registry: new ToolRegistry(),
      systemPrompt: 'test',
      toolContext: {
        cwd: process.cwd(),
        projectName: 'pending-message-test',
        externalRoots,
      },
    });

    runner.refreshExternalFilesystemRoots([{
      id: 'attachment-root',
      seq: 7,
      rootPath: 'C:\\Temp\\notes.txt',
      access: 'read',
    }]);

    expect(externalRoots).toEqual([{
      id: 'attachment-root',
      seq: 7,
      rootPath: 'C:\\Temp\\notes.txt',
      access: 'read',
    }]);
  });
});
