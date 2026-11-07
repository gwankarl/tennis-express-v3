export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/**
 * A safe delivery error that contains no recipient, credential, token, or SMTP details.
 */
export class EmailDeliveryError extends Error {
  readonly smtpCode: string | undefined;
  readonly smtpResponseCode: number | undefined;

  constructor(smtpCode?: string, smtpResponseCode?: number) {
    super('Email delivery failed.');
    this.name = 'EmailDeliveryError';
    this.smtpCode = smtpCode;
    this.smtpResponseCode = smtpResponseCode;
  }
}
