/** Branded transactional email bodies. The desktop app has no web page to land
 *  on, so the raw token/code is shown prominently for copy-paste into the app;
 *  the link (to the app base URL) is kept for a future web surface. */
import type { MailComposer, MailMessage } from '@cloudstudio/cloud-identity';

export function createMailComposer(appBaseUrl: string): MailComposer {
  const base = appBaseUrl.replace(/\/$/, '');

  const build = (to: string, subject: string, body: string, cta: string, url: string, code: string): MailMessage => ({
    to,
    subject,
    text: `${body}\n\nPaste this code into CodeStudio:\n\n    ${code}\n\nOr open the link: ${cta}: ${url}\n\nIf you didn't request this, you can safely ignore this email.`,
    html:
      `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:24px auto;color:#1f2937">` +
      `<h2 style="margin:0 0 12px">${subject}</h2>` +
      `<p style="color:#4b5563;line-height:1.6">${body}</p>` +
      `<p style="color:#4b5563;margin:20px 0 8px">Paste this code into CodeStudio:</p>` +
      `<p style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;font-weight:600;` +
      `background:#f3f4f6;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;word-break:break-all;user-select:all">${code}</p>` +
      `<p style="margin:20px 0"><a href="${url}" style="display:inline-block;background:#6366f1;color:#fff;` +
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
        token,
      );
    },
    passwordReset(to, token) {
      return build(
        to,
        'Reset your CodeStudio password',
        'We received a request to reset your password. This code expires in 1 hour.',
        'Reset password',
        `${base}/reset-password?token=${encodeURIComponent(token)}`,
        token,
      );
    },
  };
}
