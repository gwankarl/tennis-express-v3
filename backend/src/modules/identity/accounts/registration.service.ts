import type { DatabaseClient } from '../../../infrastructure/database/client.js';
import { identityCredentials } from '../passwords/credentials.table.js';
import { hashPassword } from '../passwords/credentials.js';
import { generateEmailVerificationToken } from '../token.js';
import { identityTokens } from '../token.table.js';
import { normalizeEmail } from './email-normalization.js';
import type { RegistrationRequestBody } from './registration.schema.js';
import { identityUsers } from './user.table.js';

const VERIFICATION_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Creates a pending account and its verification records atomically.
 *
 * Returns the raw verification token only when this request created the account.
 * A duplicate normalized email leaves the existing account and credential untouched.
 */
export async function createPendingAccount(
  db: DatabaseClient['db'],
  input: RegistrationRequestBody,
): Promise<string | undefined> {
  // Hash every validated attempt before the uniqueness check so duplicates don't skip
  // the expensive password operation.
  const passwordHash = await hashPassword(input.password);
  const verificationToken = generateEmailVerificationToken();
  const normalizedEmail = normalizeEmail(input.email);
  const deliveryEmail = input.email.trim();
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_LIFETIME_MS);

  return db.transaction(async (transaction) => {
    const insertedUsers = await transaction
      .insert(identityUsers)
      .values({
        deliveryEmail,
        normalizedEmail,
        status: 'pending_verification',
      })
      .onConflictDoNothing({ target: identityUsers.normalizedEmail })
      .returning({ id: identityUsers.id });

    const insertedUser = insertedUsers[0];

    if (!insertedUser) {
      return undefined;
    }

    await transaction.insert(identityCredentials).values({
      userId: insertedUser.id,
      passwordHash,
    });

    await transaction.insert(identityTokens).values({
      userId: insertedUser.id,
      purpose: 'email_verification',
      tokenDigest: verificationToken.digest,
      expiresAt,
    });

    return verificationToken.rawToken;
  });
}
