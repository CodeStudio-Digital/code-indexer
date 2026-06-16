/**
 * SubmitFeedback — the intake. Authenticated submitters are attributed; anonymous
 * submitters MUST pass Turnstile (and Turnstile must be wired). The free-text
 * message is RE-REDACTED through the shared sharing redactor (secrets/paths in a
 * pasted bug report never land in our DB). Attachments must be owned by the caller.
 */
import { type Result, ok, err, type AccountId, type IdGen, type Clock, asFeedbackTicketId } from '@cloudstudio/cloud-kernel';
import { redactText } from '@cloudstudio/cloud-sharing';
import { type FeedbackError, FeedbackErrors } from '../domain/errors.js';
import type { FeedbackKind, FeedbackTicket, Submitter } from '../domain/feedback.js';
import type { BotVerifier, FeedbackRepo } from '../domain/ports.js';

export interface SubmitFeedbackInput {
  kind: FeedbackKind;
  message: string;
  accountId: AccountId | null; // null ⇒ anonymous
  turnstileToken: string | null;
  ip: string | null;
  ipHash: string | null; // pre-hashed (salted) for anonymous forensics
  emailHash: string | null;
  appVersion: string | null;
  os: string | null;
  sessionShareId: string | null;
  attachmentIds: string[];
}

export class SubmitFeedbackUseCase {
  constructor(
    private readonly repo: FeedbackRepo,
    private readonly bot: BotVerifier,
    private readonly ids: IdGen,
    private readonly clock: Clock,
  ) {}

  async execute(input: SubmitFeedbackInput): Promise<Result<{ publicId: string }, FeedbackError>> {
    let submitter: Submitter;
    if (input.accountId) {
      submitter = { kind: 'account', accountId: input.accountId };
    } else {
      // Anonymous path: Turnstile is mandatory (and must be configured).
      if (!this.bot.enabled || !input.turnstileToken) return err(FeedbackErrors.humanRequired());
      if (!(await this.bot.verify(input.turnstileToken, input.ip))) return err(FeedbackErrors.humanFailed());
      submitter = { kind: 'anonymous', ipHash: input.ipHash ?? 'unknown', emailHash: input.emailHash };
    }

    // Attachments are auth-only and must belong to the caller.
    let attachmentIds: string[] = [];
    if (input.attachmentIds.length) {
      if (!input.accountId) return err(FeedbackErrors.attachmentNotOwned());
      const owned = await this.repo.findOwnedAttachments(input.attachmentIds, input.accountId);
      if (owned.length !== input.attachmentIds.length) return err(FeedbackErrors.attachmentNotOwned());
      attachmentIds = owned.map((a) => a.id);
    }

    const message = redactText(input.message, 'standard').value.slice(0, 4000);
    const ticket: FeedbackTicket = {
      id: asFeedbackTicketId(this.ids.uuid()),
      publicId: `fb_${this.ids.slug(10)}`,
      kind: input.kind,
      status: 'open',
      message,
      submitter,
      appVersion: input.appVersion,
      os: input.os,
      sessionShareId: input.sessionShareId,
      attachmentIds,
      createdAtMs: this.clock.now(),
    };
    await this.repo.insert(ticket);
    return ok({ publicId: ticket.publicId });
  }
}
