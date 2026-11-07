import type { EmailMessage } from '../../../infrastructure/email/email-sender.js';

export interface PasswordResetEmailInput {
  to: string;
  rawToken: string;
  frontendOrigin: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };

    return entities[character] ?? character;
  });
}

export function createPasswordResetEmail(input: PasswordResetEmailInput): EmailMessage {
  const resetUrl = new URL('/reset-password', input.frontendOrigin);
  resetUrl.searchParams.set('token', input.rawToken);
  const link = resetUrl.toString();

  return {
    to: input.to,
    subject: 'Reset your Tennis Xpress password',
    text: `Reset your Tennis Xpress password by opening this link:\n\n${link}`,
    html: `<p>Reset your Tennis Xpress password by opening this link:</p><p><a href="${escapeHtml(link)}">Reset password</a></p>`,
  };
}
