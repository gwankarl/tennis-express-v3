import type { EmailMessage } from '../../../infrastructure/email/email-sender.js';

export interface AdminMfaRecoveryEmailInput {
  to: string;
  frontendOrigin: string;
  adminHoldUntil: Date;
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

/** Sends a security notice without including recovery codes or authorization tokens. */
export function createAdminMfaRecoveryEmail(input: AdminMfaRecoveryEmailInput): EmailMessage {
  const signInUrl = new URL('/login', input.frontendOrigin).toString();
  const holdUntil = input.adminHoldUntil.toISOString();

  return {
    to: input.to,
    subject: 'Tennis Xpress administrator security recovery',
    text: [
      'Administrator MFA recovery was completed for your Tennis Xpress account.',
      `Administrator access is on hold until ${holdUntil}.`,
      'All existing sessions were signed out. Sign in again after the hold ends to set up a replacement authenticator.',
      `Sign in: ${signInUrl}`,
      'If you did not request this recovery, contact Tennis Xpress support.',
    ].join('\n\n'),
    html: [
      '<p>Administrator MFA recovery was completed for your Tennis Xpress account.</p>',
      `<p>Administrator access is on hold until ${escapeHtml(holdUntil)}.</p>`,
      '<p>All existing sessions were signed out. Sign in again after the hold ends to set up a replacement authenticator.</p>',
      `<p><a href="${escapeHtml(signInUrl)}">Sign in to Tennis Xpress</a></p>`,
      '<p>If you did not request this recovery, contact Tennis Xpress support.</p>',
    ].join(''),
  };
}
