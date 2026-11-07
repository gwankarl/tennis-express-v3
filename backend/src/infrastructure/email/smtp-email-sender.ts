import nodemailer from 'nodemailer';
import type { SmtpConfig } from '../../config/env.js';
import { EmailDeliveryError, type EmailMessage, type EmailSender } from './email-sender.js';

/**
 * Creates a reusable SMTP sender. The caller owns retry policy.
 */
export function createSmtpEmailSender(config: SmtpConfig): EmailSender {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    auth: {
      user: config.user,
      pass: config.password,
    },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  return {
    async send(message: EmailMessage): Promise<void> {
      try {
        await transporter.sendMail({
          from: config.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
      } catch (error) {
        const details =
          error !== null && typeof error === 'object'
            ? (error as { code?: unknown; responseCode?: unknown })
            : {};

        const smtpCode =
          typeof details.code === 'string' && /^[A-Z0-9_]{1,32}$/u.test(details.code)
            ? details.code
            : undefined;
        const smtpResponseCode =
          typeof details.responseCode === 'number' &&
          Number.isInteger(details.responseCode) &&
          details.responseCode >= 100 &&
          details.responseCode <= 599
            ? details.responseCode
            : undefined;

        throw new EmailDeliveryError(smtpCode, smtpResponseCode);
      }
    },
  };
}
