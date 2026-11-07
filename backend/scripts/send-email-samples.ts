import { EnvValidationError, loadBackendEnv, parseEnv } from '../src/config/env.js';
import { EmailDeliveryError } from '../src/infrastructure/email/email-sender.js';
import { createSmtpEmailSender } from '../src/infrastructure/email/smtp-email-sender.js';
import { createPasswordResetEmail } from '../src/modules/identity/passwords/password-reset-email.js';
import {
  generatePasswordRecoveryToken,
  generateEmailVerificationToken,
} from '../src/modules/identity/token.js';
import { createVerificationEmail } from '../src/modules/identity/verification/verification-email.js';
import { setTimeout as delay } from 'node:timers/promises';

async function sendSamples(): Promise<void> {
  let sampleName = 'verification';

  try {
    loadBackendEnv();
    const config = parseEnv(process.env);
    const smtp = config.email.smtp;

    if (!config.email.enabled || !smtp) {
      throw new Error();
    }

    if (smtp.host !== 'sandbox.smtp.mailtrap.io') {
      throw new Error();
    }

    const sender = createSmtpEmailSender(smtp);
    const verificationToken = generateEmailVerificationToken();
    const recoveryToken = generatePasswordRecoveryToken();
    const syntheticRecipient = 'tennis-xpress-sandbox@example.test';

    await sender.send(
      createVerificationEmail({
        to: syntheticRecipient,
        rawToken: verificationToken.rawToken,
        frontendOrigin: config.email.frontendOrigin,
      }),
    );

    sampleName = 'password reset';
    await delay(11_000);

    await sender.send(
      createPasswordResetEmail({
        to: syntheticRecipient,
        rawToken: recoveryToken.rawToken,
        frontendOrigin: config.email.frontendOrigin,
      }),
    );

    console.log('Sent one synthetic verification email and one synthetic password reset email.');
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(`Invalid backend configuration: ${error.setting}`);
    } else if (error instanceof EmailDeliveryError) {
      console.error(`Mailtrap delivery failed for the ${sampleName} email.`, {
        smtpCode: error.smtpCode ?? 'unknown',
        smtpResponseCode: error.smtpResponseCode ?? 'unknown',
      });
    } else {
      console.error(
        'Email sample setup failed. Check EMAIL_ENABLED and the Mailtrap Sandbox host.',
      );
    }

    process.exitCode = 1;
  }
}

void sendSamples();
