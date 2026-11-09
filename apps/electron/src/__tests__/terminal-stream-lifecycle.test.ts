import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createTerminalHandlers } from '@mcp/api-handlers/terminal/index.js';
import { sharedPtyManager, type IPty } from '@mcp/api-handlers/terminal/pty-manager.js';
import { pumpMessagePortStream } from '../stream-lifecycle.js';

describe('terminal output subscription', () => {
  it('detaches the real output iterable while leaving the registered PTY alive and reattachable', async () => {
    let emitExit!: (event: { exitCode: number }) => void;
    let emitData!: (data: string) => void;
    const pty: IPty = {
      pid: -1, cols: 80, rows: 24,
      onData(listener) { emitData = listener; return { dispose() {} }; },
      onExit(listener) { emitExit = listener; return { dispose() {} }; },
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    };
    const { id, entry } = sharedPtyManager.registerExternalPty(pty, { retainOnExit: true });
    const handlers = createTerminalHandlers({} as never);
    const port = Object.assign(new EventEmitter(), { start: vi.fn(), close: vi.fn(), postMessage: vi.fn() });
    const controller = new AbortController();
    try {
      const pumping = pumpMessagePortStream(port as unknown as Electron.MessagePortMain,
        () => handlers.output({ terminalId: id }, undefined as never), controller, String);
      expect(entry.listeners.size).toBe(1);
      port.emit('close'); await pumping;
      expect(entry.listeners.size).toBe(0);
      expect(entry.exited).toBe(false);
      expect(pty.kill).not.toHaveBeenCalled();
      emitData('still running');
      const reattached = handlers.output({ terminalId: id }, undefined as never)[Symbol.asyncIterator]();
      expect(await reattached.next()).toEqual({ done: false, value: { type: 'data', data: 'still running' } });
      await reattached.return?.();
      expect(pty.kill).not.toHaveBeenCalled();
    } finally {
      emitExit({ exitCode: 0 });
      sharedPtyManager.release(id);
    }
  });
});
