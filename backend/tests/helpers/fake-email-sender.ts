import {
  EmailDeliveryError,
  type EmailMessage,
  type EmailSender,
} from '../../src/infrastructure/email/email-sender.js';

export class FakeEmailSender implements EmailSender {
  readonly messages: EmailMessage[] = [];
  attempts = 0;

  private failuresRemaining = 0;
  private nextSendGate: Promise<void> | undefined;

  failNextSend(): void {
    this.failuresRemaining += 1;
  }

  holdNextSend(): () => void {
    let release!: () => void;

    this.nextSendGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    return release;
  }

  reset(): void {
    this.messages.length = 0;
    this.attempts = 0;
    this.failuresRemaining = 0;
    this.nextSendGate = undefined;
  }

  async send(message: EmailMessage): Promise<void> {
    this.attempts += 1;

    const gate = this.nextSendGate;
    this.nextSendGate = undefined;

    if (gate) {
      await gate;
    }

    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new EmailDeliveryError();
    }

    this.messages.push({ ...message });
  }
}
