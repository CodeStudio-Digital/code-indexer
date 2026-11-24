import { describe, it, expect, vi } from 'vitest';
import {
  ClefDecisions,
  defaultDecisionSettings,
  resolveDecisionMode,
  decisionText,
} from '../clef-decisions.js';
const input = {
  scope: 's1',
  kind: 'chat' as const,
  mode: 'suggest' as const,
  text: 'Planeje o trabalho.',
  provider: 'cf',
  candidates: [
    { id: 'plan', description: 'Plan only' },
    { id: 'explore', description: 'Investigate' },
  ],
  connection: () => ({ account: 'a'.repeat(32), token: 'synthetic' }),
  reserve: () => true,
};
const body = (probabilities: Record<string, number>, chosen = 'r0') => ({
  success: true,
  result: {
    model: 'clef-flash',
    answers: { pick: { type: 'choice', choice: chosen, confidence: 0.9, probabilities } },
    usage: { input_tokens: 48, output_tokens: 0 },
  },
});
describe('optional Clef decisions', () => {
  it('resolves separate overrides and performs zero network and credential lookups when off', async () => {
    const cfg = { ...defaultDecisionSettings, enabled: true, defaultMode: 'off' as const };
    expect(resolveDecisionMode(cfg, 'inherit', 'suggest')).toBe('suggest');
    expect(resolveDecisionMode(cfg, 'inherit')).toBe('off');
    expect(resolveDecisionMode({ ...cfg, enabled: false }, 'suggest')).toBe('off');
    const send = vi.fn();
    const connect = vi.fn();
    const clef = new ClefDecisions(send);
    expect((await clef.decide({ ...input, mode: 'off', connection: connect })).candidate).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
  it('sends aliases over the native endpoint, deduplicates concurrently and invalidates revoked choices', async () => {
    const send = vi.fn(async () => Response.json(body({ r0: 0.93, r1: 0.02, unknown: 0.05 })));
    const clef = new ClefDecisions(send);
    const pending = await Promise.all([clef.decide(input), clef.decide(input)]);
    expect(pending.every((r) => r.candidate === 'plan')).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await clef.decide(input)).reason).toBe('cache');
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/ai\/run\/@cf\/cloudflare\/clef-flash$/);
    const payload = JSON.parse(String(init.body));
    expect(Object.keys(payload.questions.pick.criteria)).toEqual(['r0', 'r1', 'unknown']);
    clef.invalidate();
    expect((await clef.decide({ ...input, reserve: () => false })).reason).toBe('budget');
    expect(decisionText('token=secret C:\\Users\\Private\\folder')).not.toMatch(/secret|Private/);
  });
  it('redacts absolute paths from locally chosen task and candidate text', () => {
    const text = String.raw`Review "\\storage\company\Documents Here" along with /opt/client/report and "D:\Client Docs\private.txt".`;
    expect(decisionText(text)).not.toMatch(/storage|client|private/i);
  });
  it.each([
    [{ r0: 0.64, r1: 0.3, unknown: 0.06 }, 'r0'],
    [{ r0: 0.01, r1: 0.02, unknown: 0.97 }, 'unknown'],
    [{ r0: 1, other: 0 }, 'r0'],
  ])('abstains for ambiguous, unknown and invalid results', async (dist, selected) => {
    const clef = new ClefDecisions(async () =>
      Response.json(body(dist as Record<string, number>, String(selected))),
    );
    expect((await clef.decide(input)).candidate).toBeNull();
  });
  it('does not spend a request when local candidate selection exhausted the deadline', async () => {
    const reserve = vi.fn(() => true);
    const transport = vi.fn();
    expect(
      await new ClefDecisions(transport).decide({ ...input, reserve, deadlineAt: Date.now() - 1 }),
    ).toMatchObject({ reason: 'timeout', candidate: null });
    expect(reserve).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it('cancels a stalled request at the host deadline and discards an answer after disabling', async () => {
    const stalled = new ClefDecisions(
      async (_url, init) =>
        new Promise<Response>((_, reject) => {
          init!.signal!.addEventListener('abort', () => reject(Error('aborted')), { once: true });
        }),
    );
    expect((await stalled.decide(input)).reason).toBe('timeout');
    let finish!: (value: Response) => void;
    const client = new ClefDecisions(
      () =>
        new Promise<Response>((ok) => {
          finish = ok;
        }),
    );
    const late = client.decide(input);
    client.invalidate();
    finish(Response.json(body({ r0: 0.98, r1: 0.01, unknown: 0.01 })));
    expect(await late).toMatchObject({ candidate: null, reason: 'cancelled' });
  });
  it.each([401, 403, 429, 503])(
    'handles HTTP %s without retrying or changing the chat model',
    async (status) => {
      const send = vi.fn(async () => new Response(null, { status }));
      const result = await new ClefDecisions(send).decide(input);
      expect(result.reason).toBe('http_' + status);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
});
