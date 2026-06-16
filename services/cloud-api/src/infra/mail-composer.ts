/** Branded transactional email bodies. Links point at the app base URL; the
 *  app routes `/verify-email` and `/reset-password` post the token to the API. */
import type { MailComposer, MailMessage } from '@cloudstudio/cloud-identity';

export function createMailComposer(appBaseUrl: string): MailComposer {
  const base = appBaseUrl.replace(/\/$/, '');

  const build = (to: string, subject: string, body: string, cta: string, url: string): MailMessage => ({
    to,
    subject,
    text: `${body}\n\n${cta}: ${url}\n\nIf you didn't request this, you can safely ignore this email.`,
    html:
      `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:24px auto;color:#1f2937">` +
      `<h2 style="margin:0 0 12px">${subject}</h2>` +
      `<p style="color:#4b5563;line-height:1.6">${body}</p>` +
      `<p style="margin:24px 0"><a href="${url}" style="display:inline-block;background:#6366f1;color:#fff;` +
      `padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">${cta}</a></p>` +
      `<p style="color:#9ca3af;font-size:12px">If you didn't request this, you can safely ignore this email.</p></div>`,
  });

  return {
    verification(to, token) {
      return build(
        to,
        'Confirm your CodeStudio email',
        'Welcome to CodeStudio! Confirm your email address to finish setting up your account.',
        'Confirm email',
        `${base}/verify-email?token=${encodeURIComponent(token)}`,
      );
    },
    passwordReset(to, token) {
      return build(
        to,
        'Reset your CodeStudio password',
        'We received a request to reset your password. This link expires in 1 hour.',
        'Reset password',
        `${base}/reset-password?token=${encodeURIComponent(token)}`,
      );
    },
  };
}
