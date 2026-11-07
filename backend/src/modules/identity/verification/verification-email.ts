import type { EmailMessage } from '../../../infrastructure/email/email-sender.js';

export interface VerificationEmailInput {
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

export function createVerificationEmail(input: VerificationEmailInput): EmailMessage {
  const verificationUrl = new URL('/verify-email', input.frontendOrigin);
  verificationUrl.searchParams.set('token', input.rawToken);
  const link = verificationUrl.toString();

  return {
    to: input.to,
    subject: 'Verify your Tennis Xpress email',
    text: `Verify your Tennis Xpress email by opening this link:\n\n${link}`,
    html: `<p>Verify your Tennis Xpress email by opening this link:</p><p><a href="${escapeHtml(link)}">Verify email address</a></p>`,
  };
}
