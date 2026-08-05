import { PassThrough, Writable } from 'node:stream';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  activatePayload,
  ackPayload,
  agentHelloFrame,
  attemptPreparedFrame,
  captureWritable,
  decodeFrame,
  delimit,
  heartbeatFrame,
  hostBootstrap,
  hostHello,
  inboundAckFrame,
  preparePayload,
  terminalCommittedPayload,
  terminalProposalFrame,
} from './attempt-channel-support.js';
import { framePayloadSha256 } from '../ipc/AttemptFrame.js';
import type { PendingInbound } from '../ipc/AttemptFrameReceiver.js';
import { inspectPending } from '../ipc/AttemptFrameTransaction.js';

async function establishedWith(
  frames: readonly Uint8Array[],
  options: Parameters<typeof hostBootstrap>[1] = {},
) {
  const setup = hostBootstrap([agentHelloFrame(), ...frames], options);
  await setup.bootstrap.receiveAgentHello();
  const established = await setup.bootstrap.establish(hostHello());
  return { ...setup, established };
}

function ackFor(pending: PendingInbound, acknowledgedAtUnixMs = 10n) {
  const inbound = inspectPending(pending);
  return ackPayload(
    inbound.messageId,
    inbound.payloadDigest,
    acknowledgedAtUnixMs,
  );
}

describe('established outbound header authority', () => {
  it('keeps a permanent receive live while committing a correlated outbound', async () => {
    const input = new PassThrough();
    input.write(delimit(agentHelloFrame()));
    let writeCount = 0;
    let releaseRequest!: () => void;
    let publishRequest!: (frame: Uint8Array) => void;
    const requestBody = new Promise<Uint8Array>((resolve) => {
      publishRequest = resolve;
    });
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        writeCount += 1;
        if (writeCount === 4) {
          publishRequest(Uint8Array.from(chunk));
          releaseRequest = () => callback();
          return;
        }
        callback();
      },
    });
    const setup = hostBootstrap([], { readable: input, writable });
    await setup.bootstrap.receiveAgentHello();
    const established = await setup.bootstrap.establish(hostHello());
    const receiving = established.beginReceive();
    const sending = established.sendNew(activatePayload(), { timeoutMs: 1_000 });
    const request = decodeFrame(await requestBody);
    input.write(delimit(inboundAckFrame(
      'activation-ack-2',
      2n,
      request.header!.messageId,
      framePayloadSha256(request.encodedPayload),
    )));
    let received = false;
    void receiving.then(() => { received = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(received).toBe(false);

    releaseRequest();
    const outbound = await sending;
    const inbound = await receiving;
    if (inbound.kind !== 'pending') throw new Error('pending expected');
    const binding = inbound.pending.binding();
    const receipt = established.commitAccepted(inbound.pending);

    expect(outbound.outboundMessageId()).toBe(request.header!.messageId);
    expect(established.receiptMatches(
      receipt,
      binding,
    )).toBe(true);
    expect(established.isPoisoned).toBe(false);
    established.abort();
  });

  it('generates a new envelope for a semantic retry with stable payload', async () => {
    const { established, capture } = await establishedWith([]);
    const payload = preparePayload();

    const firstReceipt = await established.sendNew(
      payload,
      { timeoutMs: 10 },
    );
    const secondReceipt = await established.sendNew(
      payload,
      { timeoutMs: 10 },
    );

    expect(firstReceipt.outboundStreamSeq()).toBe(2n);
    expect(secondReceipt.outboundStreamSeq()).toBe(3n);
    expect(secondReceipt.outboundMessageId()).not.toBe(
      firstReceipt.outboundMessageId(),
    );
    expect(established.outboundReceiptMatches(firstReceipt)).toBe(true);
    expect(established.outboundReceiptMatches({} as never)).toBe(false);
    const raw = capture!.frames();
    expect(raw).toHaveLength(3);
    const firstFrame = decodeFrame(raw[1]!);
    const secondFrame = decodeFrame(raw[2]!);
    expect(firstFrame.header).not.toHaveProperty('replyToMessageId');
    expect(secondFrame.header).not.toHaveProperty('replyToMessageId');
    expect(firstFrame.encodedPayload).toEqual(secondFrame.encodedPayload);
    expect(raw[1]).not.toEqual(raw[2]);
    established.abort();
  });

  it('resends exact physical response bytes without reserving sequence', async () => {
    const heartbeat = heartbeatFrame('heartbeat-2', 2n);
    const { established, capture } = await establishedWith([
      heartbeat,
      heartbeat,
    ]);
    const first = await established.beginReceive();
    if (first?.kind !== 'pending') throw new Error('pending expected');
    await established.commitResponse(
      first.pending,
      ackFor(first.pending),
      { timeoutMs: 10 },
    );

    const replay = await established.beginReceive();

    expect(replay.kind).toBe('replayed');
    const raw = capture!.frames();
    expect(raw).toHaveLength(3);
    expect(raw[2]).toEqual(raw[1]);
    expect(decodeFrame(raw[2]!).header).toMatchObject({
      streamSeq: 2n,
      replyToMessageId: 'heartbeat-2',
    });
  });

  it('poisons all authority when the response write fails', async () => {
    const capture = captureWritable(3);
    const { established } = await establishedWith(
      [heartbeatFrame('heartbeat-2', 2n)],
      { writable: capture.writable },
    );
    const inbound = await established.beginReceive();
    if (inbound?.kind !== 'pending') throw new Error('pending expected');

    await expect(
      established.commitResponse(
        inbound.pending,
        ackFor(inbound.pending),
        { timeoutMs: 10 },
      ),
    ).rejects.toMatchObject({ code: 'transport_error' });
    expect(established.isPoisoned).toBe(true);
    expect(capture.frames()).toHaveLength(1);
  });

  it('rejects a zero timeout before publishing a response', async () => {
    const { established, capture } = await establishedWith([
      heartbeatFrame('heartbeat-2', 2n),
    ]);
    const inbound = await established.beginReceive();
    if (inbound?.kind !== 'pending') throw new Error('pending expected');

    await expect(
      established.commitResponse(
        inbound.pending,
        ackFor(inbound.pending),
        { timeoutMs: 0 },
      ),
    ).rejects.toMatchObject({ code: 'invalid_deadline' });
    expect(established.isPoisoned).toBe(true);
    expect(capture!.frames()).toHaveLength(1);
  });

  it('samples the construction clock for every outbound reservation', async () => {
    let now = 10n;
    const { established, capture } = await establishedWith([
      heartbeatFrame('heartbeat-2', 2n),
    ], { clock: () => now });
    now = 15n;
    const inbound = await established.beginReceive();
    if (inbound?.kind !== 'pending') throw new Error('pending expected');
    await established.commitResponse(
      inbound.pending,
      ackFor(inbound.pending, 15n),
      { timeoutMs: 5 },
    );

    const frame = decodeFrame(capture!.frames()[1]!);
    expect(frame.header?.sentAtUnixMs).toBe(15n);
    expect(frame.header?.deadlineAtUnixMs).toBe(20n);
    const payload = fromBinary(
      agentV1Runtime.FramePayloadSchema,
      frame.encodedPayload,
    );
    expect(payload.body.case).toBe('ack');
  });

  it('irreversibly closes both directions on established EOF', async () => {
    const { established } = await establishedWith([]);

    await expect(established.beginReceive()).rejects.toMatchObject({
      code: 'unexpected_eof',
    });
    expect(established.isPoisoned).toBe(true);
  });

  it('originates Prepare and Activate with committed receipts and correlation', async () => {
    const input = new PassThrough();
    input.write(delimit(agentHelloFrame()));
    const setup = hostBootstrap([], { readable: input });
    await setup.bootstrap.receiveAgentHello();
    const established = await setup.bootstrap.establish(hostHello());

    const prepare = preparePayload();
    const preparedRequest = await established.sendNew(
      prepare,
      { timeoutMs: 10 },
    );
    expect(preparedRequest.outboundStreamSeq()).toBe(2n);
    expect(established.outboundReceiptMatches(preparedRequest)).toBe(true);
    expect(established.outboundReceiptMatches({} as never)).toBe(false);

    input.write(delimit(attemptPreparedFrame(
      'attempt-prepared-2',
      2n,
      preparedRequest.outboundMessageId(),
    )));
    const prepared = await established.beginReceive();
    if (prepared.kind !== 'pending') throw new Error('prepared expected');
    established.commitAccepted(prepared.pending);

    const activate = activatePayload();
    const activatedRequest = await established.sendNew(
      activate,
      { timeoutMs: 10 },
    );
    expect(activatedRequest.outboundStreamSeq()).toBe(3n);
    const activateDigest = framePayloadSha256(
      toBinary(agentV1Runtime.FramePayloadSchema, activate),
    );
    input.write(delimit(inboundAckFrame(
      'activate-ack-3',
      3n,
      activatedRequest.outboundMessageId(),
      activateDigest,
    )));
    const activated = await established.beginReceive();
    if (activated.kind !== 'pending') throw new Error('ack expected');
    established.commitAccepted(activated.pending);

    const frames = setup.capture!.frames();
    expect(frames).toHaveLength(3);
    const prepareHeader = decodeFrame(frames[1]!).header;
    expect(prepareHeader).toMatchObject({ streamSeq: 2n });
    expect(prepareHeader).not.toHaveProperty('replyToMessageId');
    const activateHeader = decodeFrame(frames[2]!).header;
    expect(activateHeader).toMatchObject({ streamSeq: 3n });
    expect(activateHeader).not.toHaveProperty('replyToMessageId');
    established.abort();
  });

  it('rejects crossed new/response dispositions', async () => {
    const responseSetup = await establishedWith([
      heartbeatFrame('heartbeat-2', 2n),
    ]);
    const inbound = await responseSetup.established.beginReceive();
    if (inbound.kind !== 'pending') throw new Error('pending expected');
    await expect(responseSetup.established.commitResponse(
      inbound.pending,
      preparePayload(),
      { timeoutMs: 10 },
    )).rejects.toMatchObject({ code: 'invalid_correlation' });
    expect(responseSetup.established.isPoisoned).toBe(true);

    const newSetup = await establishedWith([]);
    await expect(newSetup.established.sendNew(
      ackPayload(),
      { timeoutMs: 10 },
    )).rejects.toMatchObject({ code: 'invalid_correlation' });
    expect(newSetup.established.isPoisoned).toBe(true);
  });

  it.each([
    [
      'message id',
      (pending: PendingInbound) => {
        const inbound = inspectPending(pending);
        return ackPayload('forged-id', inbound.payloadDigest, 10n);
      },
    ],
    [
      'payload digest',
      (pending: PendingInbound) => {
        const inbound = inspectPending(pending);
        return ackPayload(inbound.messageId, new Uint8Array(32), 10n);
      },
    ],
    [
      'lower timestamp bound',
      (pending: PendingInbound) => {
        const inbound = inspectPending(pending);
        return ackPayload(inbound.messageId, inbound.payloadDigest, 0n);
      },
    ],
    [
      'upper timestamp bound',
      (pending: PendingInbound) => {
        const inbound = inspectPending(pending);
        return ackPayload(inbound.messageId, inbound.payloadDigest, 11n);
      },
    ],
  ])('rejects a forged outbound Ack %s', async (_name, forge) => {
    const { established, capture } = await establishedWith([
      heartbeatFrame('heartbeat-2', 2n),
    ]);
    const inbound = await established.beginReceive();
    if (inbound.kind !== 'pending') throw new Error('pending expected');

    await expect(established.commitResponse(
      inbound.pending,
      forge(inbound.pending),
      { timeoutMs: 10 },
    )).rejects.toMatchObject({ code: 'invalid_correlation' });
    expect(capture!.frames()).toHaveLength(1);
    expect(established.isPoisoned).toBe(true);
  });

  it.each([
    [
      'proposal id',
      (digest: Uint8Array) => terminalCommittedPayload(
        'forged-proposal',
        digest,
      ),
    ],
    [
      'terminal digest',
      () => terminalCommittedPayload(
        'terminal-proposal-2',
        new Uint8Array(32),
      ),
    ],
    [
      'commit timestamp',
      (digest: Uint8Array) => terminalCommittedPayload(
        'terminal-proposal-2',
        digest,
        11n,
      ),
    ],
  ])('rejects forged TerminalCommitted %s', async (_name, forge) => {
    const terminalDigest = Uint8Array.from(
      { length: 32 },
      (_value, index) => index + 1,
    );
    const { established, capture } = await establishedWith([
      terminalProposalFrame(
        'terminal-proposal-2',
        2n,
        terminalDigest,
      ),
    ]);
    const inbound = await established.beginReceive();
    if (inbound.kind !== 'pending') throw new Error('pending expected');

    await expect(established.commitResponse(
      inbound.pending,
      forge(terminalDigest),
      { timeoutMs: 10 },
    )).rejects.toMatchObject({ code: 'invalid_correlation' });
    expect(capture!.frames()).toHaveLength(1);
    expect(established.isPoisoned).toBe(true);
  });

  it.each([
    ['spec digest', new Uint8Array(32).fill(1), 10n],
    ['ready timestamp', new Uint8Array(32), 0n],
    ['observed timestamp', new Uint8Array(32), 61n],
  ])('rejects forged AttemptPrepared %s', async (
    _name,
    specSha256,
    readyAtUnixMs,
  ) => {
    const input = new PassThrough();
    input.write(delimit(agentHelloFrame()));
    const setup = hostBootstrap([], { readable: input });
    await setup.bootstrap.receiveAgentHello();
    const established = await setup.bootstrap.establish(hostHello());
    const request = await established.sendNew(
      preparePayload(),
      { timeoutMs: 10 },
    );
    input.write(delimit(attemptPreparedFrame(
      'attempt-prepared-2',
      2n,
      request.outboundMessageId(),
      undefined,
      specSha256,
      readyAtUnixMs,
    )));

    await expect(established.beginReceive()).rejects.toMatchObject({
      code: 'correlation_mismatch',
    });
    expect(established.isPoisoned).toBe(true);
  });

  it('caps new frame deadlines at the sealed launch hard deadline', async () => {
    let now = 10n;
    const { established, capture } = await establishedWith(
      [],
      { clock: () => now },
    );
    now = 69_995n;

    await established.sendNew(preparePayload(), { timeoutMs: 10 });

    expect(decodeFrame(capture!.frames()[1]!).header).toMatchObject({
      sentAtUnixMs: 69_995n,
      deadlineAtUnixMs: 70_000n,
    });
    established.abort();
  });

  it('reaps and scrubs a pending handler at its internal deadline', async () => {
    vi.useFakeTimers();
    try {
      let now = 10n;
      const { established } = await establishedWith(
        [heartbeatFrame('heartbeat-2', 2n)],
        { clock: () => now },
      );
      const inbound = await established.beginReceive();
      if (inbound.kind !== 'pending') throw new Error('pending expected');

      now = 60_010n;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(established.isPoisoned).toBe(true);
      expect(() => inbound.pending.header()).toThrow(
        expect.objectContaining({ code: 'invalid_pending' }),
      );
      expect(() => established.commitAccepted(inbound.pending)).toThrow(
        expect.objectContaining({ code: 'receiver_poisoned' }),
      );
      established.abort();
    } finally {
      vi.useRealTimers();
    }
  });
});
