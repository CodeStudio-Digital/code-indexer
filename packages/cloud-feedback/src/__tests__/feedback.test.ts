/**
 * Feedback use-case tests with fakes. Covers attributed vs anonymous submit
 * (Turnstile gating), free-text re-redaction, attachment ownership enforcement,
 * and list-own (spam hidden). No D1, no R2, no network.
 */
import { describe, it, expect } from 'vitest';
import { type Clock, type IdGen, asAccountId, type AccountId } from '@cloudstudio/cloud-kernel';
import {
  SubmitFeedbackUseCase,
  ListOwnFeedbackUseCase,
  type BotVerifier,
  type FeedbackAttachment,
  type FeedbackRepo,
  type FeedbackSummary,
  type FeedbackTicket,
} from '@cloudstudio/cloud-feedback';

let seq = 0;
const ids: IdGen = { uuid: () => `id_${++seq}`, slug: () => `s${++seq}` };
const clock: Clock = { now: () => 1_700_000_000_000, isoNow: () => 'now' };
const acc = asAccountId('acc1');

const bot = (enabled: boolean, pass = true): BotVerifier => ({ enabled, verify: async () => pass });

class FakeFeedbackRepo implements FeedbackRepo {
  tickets: FeedbackTicket[] = [];
  atts = new Map<string, FeedbackAttachment>();
  async insert(t: FeedbackTicket) {
    this.tickets.push(t);
  }
  async listByAccount(accountId: AccountId): Promise<FeedbackSummary[]> {
    return this.tickets
      .filter((t) => t.submitter.kind === 'account' && t.submitter.accountId === accountId && t.status !== 'spam')
      .map((t) => ({ publicId: t.publicId, kind: t.kind, status: t.status, message: t.message, appVersion: t.appVersion, attachmentCount: t.attachmentIds.length, createdAtMs: t.createdAtMs }));
  }
  async insertAttachment(a: FeedbackAttachment) {
    this.atts.set(a.id, a);
  }
  async findOwnedAttachments(idsIn: readonly string[], accountId: AccountId) {
    return idsIn.map((id) => this.atts.get(id)).filter((a): a is FeedbackAttachment => !!a && a.accountId === accountId);
  }
}

function build(botVerifier = bot(true)) {
  const repo = new FakeFeedbackRepo();
  return { repo, submit: new SubmitFeedbackUseCase(repo, botVerifier, ids, clock), list: new ListOwnFeedbackUseCase(repo) };
}

const base = { turnstileToken: null, ip: null, ipHash: null, emailHash: null, appVersion: null, os: null, sessionShareId: null, attachmentIds: [] as string[] };

describe('SubmitFeedback', () => {
  it('accepts an authenticated submit and re-redacts secrets from the message', async () => {
    const t = build();
    const r = await t.submit.execute({ ...base, kind: 'bug', message: 'broke with key sk-ant-api03-LEAKEDLEAKEDLEAKED here', accountId: acc });
    expect(r.ok).toBe(true);
    expect(t.repo.tickets[0].message).not.toContain('sk-ant-api03');
    expect(t.repo.tickets[0].submitter).toEqual({ kind: 'account', accountId: acc });
  });

  it('rejects anonymous submit without Turnstile (human_verification_required)', async () => {
    const t = build();
    const r = await t.submit.execute({ ...base, kind: 'idea', message: 'hi', accountId: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('human_verification_required');
  });

  it('rejects anonymous submit when Turnstile is not configured', async () => {
    const t = build(bot(false));
    const r = await t.submit.execute({ ...base, kind: 'idea', message: 'hi', accountId: null, turnstileToken: 'tok' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('human_verification_required');
  });

  it('rejects anonymous submit when Turnstile verification fails', async () => {
    const t = build(bot(true, false));
    const r = await t.submit.execute({ ...base, kind: 'idea', message: 'hi', accountId: null, turnstileToken: 'bad', ipHash: 'h' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('human_verification_failed');
  });

  it('accepts anonymous submit with a valid Turnstile token', async () => {
    const t = build(bot(true, true));
    const r = await t.submit.execute({ ...base, kind: 'other', message: 'hello', accountId: null, turnstileToken: 'ok', ipHash: 'iphash' });
    expect(r.ok).toBe(true);
    expect(t.repo.tickets[0].submitter).toEqual({ kind: 'anonymous', ipHash: 'iphash', emailHash: null });
  });

  it('rejects attachments not owned by the caller', async () => {
    const t = build();
    const r = await t.submit.execute({ ...base, kind: 'bug', message: 'x', accountId: acc, attachmentIds: ['ghost'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('attachment_not_owned');
  });

  it('links owned attachments', async () => {
    const t = build();
    await t.repo.insertAttachment({ id: 'att1', accountId: acc, r2Key: 'k', contentType: 'image/png', kind: 'image', byteSize: 10, createdAtMs: 1 });
    const r = await t.submit.execute({ ...base, kind: 'bug', message: 'x', accountId: acc, attachmentIds: ['att1'] });
    expect(r.ok).toBe(true);
    expect(t.repo.tickets[0].attachmentIds).toEqual(['att1']);
  });
});

describe('ListOwnFeedback', () => {
  it('returns the account tickets as summaries', async () => {
    const t = build();
    await t.submit.execute({ ...base, kind: 'bug', message: 'one', accountId: acc });
    await t.submit.execute({ ...base, kind: 'idea', message: 'two', accountId: acc });
    const items = await t.list.execute({ accountId: acc });
    expect(items.length).toBe(2);
    expect(items[0].kind).toBeDefined();
  });
});
