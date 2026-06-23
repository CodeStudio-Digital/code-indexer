/**
 * EmailSender adapter. Uses the Cloudflare Email Sending binding (`env.EMAIL`)
 * when present; otherwise logs to the console (local dev — the `send_email`
 * binding needs a verified sender domain, see docs/cloud-api/PROGRESS.md).
 */
import type { EmailSender, MailMessage } from '@cloudstudio/cloud-identity';

/** Cloudflare Email Sending binding (`env.EMAIL`). The current API takes a
 *  structured object with `from: { email, name }` and returns `{ messageId }`;
 *  passing `from` as a bare string (the old assumption) is rejected. */
export interface EmailServiceBinding {
  send(message: {
    to: string;
    from: { email: string; name?: string };
    subject: string;
    html: string;
    text: string;
  }): Promise<{ messageId?: string }>;
}

const FROM_NAME = 'CodeStudio';

export function createEmailSender(
  binding: EmailServiceBinding | undefined,
  from: string,
  debugLogBody = false,
): EmailSender {
  return {
    async send(message: MailMessage) {
      if (binding) {
        await binding.send({
          to: message.to,
          from: { email: from, name: FROM_NAME },
          subject: message.subject,
          html: message.html,
          text: message.text,
        });
        return;
      }
      // No EMAIL binding. The body carries one-time reset/verification tokens, so it
      // must NEVER be logged in production (CWE-532). Logging the body is an EXPLICIT,
      // gitignored, dev-only opt-in (`EMAIL_DEBUG_LOG_BODY=1` in .dev.vars) — prod
      // never sets it, so it cannot accidentally leak. Otherwise drop with a
      // token-free, recipient-free breadcrumb.
      if (debugLogBody) {
        console.log(`[email:dev] to=${message.to} subject="${message.subject}"\n${message.text}`);
        return;
      }
      console.warn(`[email] EMAIL binding not configured — "${message.subject}" not sent (body+recipient suppressed)`);
    },
  };
}
