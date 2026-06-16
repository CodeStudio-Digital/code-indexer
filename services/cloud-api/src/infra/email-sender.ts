/**
 * EmailSender adapter. Uses the Cloudflare Email Sending binding (`env.EMAIL`)
 * when present; otherwise logs to the console (local dev — the `send_email`
 * binding needs a verified sender domain, see docs/cloud-api/PROGRESS.md).
 */
import type { EmailSender, MailMessage } from '@cloudstudio/cloud-identity';

export interface EmailServiceBinding {
  send(message: { to: string; from: string; subject: string; html: string; text: string }): Promise<unknown>;
}

export function createEmailSender(binding: EmailServiceBinding | undefined, from: string): EmailSender {
  return {
    async send(message: MailMessage) {
      if (!binding) {
        console.log(`[email:dev] to=${message.to} subject="${message.subject}"\n${message.text}`);
        return;
      }
      await binding.send({
        to: message.to,
        from,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
    },
  };
}
