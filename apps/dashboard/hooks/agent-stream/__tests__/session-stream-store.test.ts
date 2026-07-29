import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAgentStreamStoreForTests,
  AgentStreamOwnership,
  agentStreamLastSeenBusIdMap,
  agentStreamLastSeenSeqMap,
  getAgentCurrentTurnSnapshot,
  getAgentSessionSnapshot,
  readAgentStreamCursor,
  subscribeAgentCurrentTurn,
  subscribeAgentSession,
  updateAgentSession,
} from '../session-stream-store.js';

const sid = (id: number) =>
  `10000000-0000-4000-8000-${String(id).padStart(12, '0')}`;

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  __resetAgentStreamStoreForTests();
});

describe('AgentStreamOwnership', () => {
  it('gives two attach consumers one logical transport and fans out completion', async () => {
    const ownership = new AgentStreamOwnership();
    const transport = deferred();
    const start = vi.fn(() => transport.promise);
    const firstComplete = vi.fn();
    const secondComplete = vi.fn();
    let notifyMessageComplete!: () => void;

    const first = ownership.run(
      sid(42),
      Symbol('full-chat'),
      'attach',
      firstComplete,
      (notify) => {
        notifyMessageComplete = notify;
        return start();
      },
    );
    const second = ownership.run(
      sid(42),
      Symbol('editor-rail'),
      'attach',
      secondComplete,
      () => start(),
    );

    expect(first).toBe(second);
    expect(start).toHaveBeenCalledTimes(1);
    expect(ownership.isActive(sid(42))).toBe(true);

    notifyMessageComplete();
    expect(firstComplete).toHaveBeenCalledTimes(1);
    expect(secondComplete).toHaveBeenCalledTimes(1);

    transport.resolve();
    await first;
    expect(ownership.isActive(sid(42))).toBe(false);
  });

  it('releasing a hidden consumer neither stops nor clears the visible owner', async () => {
    const ownership = new AgentStreamOwnership();
    const transport = deferred();
    const hidden = Symbol('hidden');
    const visible = Symbol('visible');
    const hiddenComplete = vi.fn();
    const visibleComplete = vi.fn();
    let notifyMessageComplete!: () => void;

    const active = ownership.run(sid(7), hidden, 'attach', hiddenComplete, (notify) => {
      notifyMessageComplete = notify;
      return transport.promise;
    });
    ownership.run(sid(7), visible, 'attach', visibleComplete, () => {
      throw new Error('must join');
    });

    ownership.releaseConsumer(hidden, sid(7));
    expect(ownership.isActive(sid(7))).toBe(true);
    notifyMessageComplete();
    expect(hiddenComplete).not.toHaveBeenCalled();
    expect(visibleComplete).toHaveBeenCalledTimes(1);

    transport.resolve();
    await active;
  });

  it('lets a POST command replace an attach owner without stale cleanup winning', async () => {
    const ownership = new AgentStreamOwnership();
    const attach = deferred();
    const command = deferred();
    const consumer = Symbol('chat');

    const oldPromise = ownership.run(
      sid(9),
      consumer,
      'attach',
      undefined,
      () => attach.promise,
    );
    const newPromise = ownership.run(
      sid(9),
      consumer,
      'command',
      undefined,
      () => command.promise,
    );
    expect(newPromise).not.toBe(oldPromise);

    attach.resolve();
    await oldPromise;
    expect(ownership.isActive(sid(9))).toBe(true);

    command.resolve();
    await newPromise;
    expect(ownership.isActive(sid(9))).toBe(false);
  });
});

describe('agent stream cursor lifetime', () => {
  it('survives a consumer remount and never exposes an unpaired sequence', () => {
    agentStreamLastSeenSeqMap.set(sid(12), 88);
    expect(readAgentStreamCursor(sid(12))).toEqual({ seq: -1 });

    agentStreamLastSeenBusIdMap.set(sid(12), 'bus-12');
    expect(readAgentStreamCursor(sid(12))).toEqual({
      seq: 88,
      busId: 'bus-12',
    });

    // Releasing/remounting a React consumer only affects callbacks. The
    // process-owned cursor remains the Last-Event-ID for the next attach.
    const ownership = new AgentStreamOwnership();
    ownership.releaseConsumer(Symbol('old-mount'), sid(12));
    expect(readAgentStreamCursor(sid(12))).toEqual({
      seq: 88,
      busId: 'bus-12',
    });
  });
});

describe('shared session state', () => {
  it('publishes one session state to two surfaces without teardown coupling', () => {
    const fullChat = vi.fn();
    const editorRail = vi.fn();
    const releaseFullChat = subscribeAgentSession(sid(21), fullChat);
    subscribeAgentSession(sid(21), editorRail);

    updateAgentSession(sid(21), { streaming: true });
    expect(getAgentSessionSnapshot(sid(21)).streaming).toBe(true);
    expect(fullChat).toHaveBeenCalledTimes(1);
    expect(editorRail).toHaveBeenCalledTimes(1);

    releaseFullChat();
    updateAgentSession(sid(21), { error: 'transport lost' });
    expect(fullChat).toHaveBeenCalledTimes(1);
    expect(editorRail).toHaveBeenCalledTimes(2);
    expect(getAgentSessionSnapshot(sid(21)).streaming).toBe(true);
  });

  it('keeps token churn on the narrow shared current-turn channel', () => {
    const shell = vi.fn();
    const transcript = vi.fn();
    subscribeAgentSession(sid(22), shell);
    subscribeAgentCurrentTurn(sid(22), transcript);

    updateAgentSession(sid(22), {
      currentTurn: {
        blocks: [{ type: 'text', text: 'hello', id: 'text-1' }],
      },
    });

    expect(shell).not.toHaveBeenCalled();
    expect(transcript).toHaveBeenCalledTimes(1);
    expect(getAgentCurrentTurnSnapshot(sid(22))?.blocks).toHaveLength(1);
  });
});
