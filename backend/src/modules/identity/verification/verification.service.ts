import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { DatabaseClient } from '../../../infrastructure/database/client.js';
import { identityUsers } from '../accounts/user.table.js';
import { identityCredentials } from '../passwords/credentials.table.js';
import { verifyPassword } from '../passwords/credentials.js';
import { digestIdentityToken, generateEmailVerificationToken, isTokenExpired } from '../token.js';
import { identityTokens } from '../token.table.js';
import type {
  ResendVerificationRequestBody,
  VerifyEmailRequestBody,
} from './verification.schema.js';

const VERIFICATION_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Verifies an email token and password atomically.
 *
 * The user row is locked before the token row. This serializes attempts using
 * either the same token or different links for the same account.
 */
export async function verifyEmail(
  db: DatabaseClient['db'],
  input: VerifyEmailRequestBody,
): Promise<boolean> {
  const digest = digestIdentityToken(input.token);

  return db.transaction(async (transaction) => {
    // This initial read only discovers the account ID. Re-read and validate the
    // token under locks below.
    const candidates = await transaction
      .select({
        id: identityTokens.id,
        userId: identityTokens.userId,
      })
      .from(identityTokens)
      .where(
        and(
          eq(identityTokens.tokenDigest, digest),
          eq(identityTokens.purpose, 'email_verification'),
        ),
      )
      .limit(1);

    const candidate = candidates[0];

    if (!candidate) {
      return false;
    }

    // Lock accounts first so submissions using different links can't deadlock
    // while invalidating the other verification tokens.
    const users = await transaction
      .select({
        id: identityUsers.id,
        status: identityUsers.status,
        emailVerifiedAt: identityUsers.emailVerifiedAt,
      })
      .from(identityUsers)
      .where(eq(identityUsers.id, candidate.userId))
      .for('update')
      .limit(1);

    const user = users[0];

    if (!user || user.status !== 'pending_verification' || user.emailVerifiedAt !== null) {
      return false;
    }

    const tokens = await transaction
      .select({
        id: identityTokens.id,
        expiresAt: identityTokens.expiresAt,
        consumedAt: identityTokens.consumedAt,
      })
      .from(identityTokens)
      .where(
        and(
          eq(identityTokens.id, candidate.id),
          eq(identityTokens.tokenDigest, digest),
          eq(identityTokens.purpose, 'email_verification'),
          eq(identityTokens.userId, user.id),
        ),
      )
      .for('update')
      .limit(1);

    const token = tokens[0];

    if (!token || token.consumedAt !== null || isTokenExpired(token.expiresAt, new Date())) {
      return false;
    }

    const credentials = await transaction
      .select({ passwordHash: identityCredentials.passwordHash })
      .from(identityCredentials)
      .where(eq(identityCredentials.userId, user.id))
      .limit(1);

    const credential = credentials[0];

    if (!credential || !(await verifyPassword(input.password, credential.passwordHash))) {
      return false;
    }

    // Password verification is deliberately expensive. Consume the selected
    // token with a database-clock expiry check after that work, atomically with
    // the account activation below.
    const consumedAt = new Date();
    const consumed = await transaction
      .update(identityTokens)
      .set({ consumedAt })
      .where(
        and(
          eq(identityTokens.id, token.id),
          eq(identityTokens.userId, user.id),
          eq(identityTokens.purpose, 'email_verification'),
          isNull(identityTokens.consumedAt),
          gt(identityTokens.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .returning({ id: identityTokens.id });

    if (consumed.length !== 1) {
      return false;
    }

    const updatedUsers = await transaction
      .update(identityUsers)
      .set({
        status: 'active',
        emailVerifiedAt: consumedAt,
        updatedAt: consumedAt,
      })
      .where(
        and(
          eq(identityUsers.id, user.id),
          eq(identityUsers.status, 'pending_verification'),
          isNull(identityUsers.emailVerifiedAt),
        ),
      )
      .returning({ id: identityUsers.id });

    if (updatedUsers.length !== 1) {
      return false;
    }

    // Invalidate every other verification link for this account in the same
    // transaction as the account activation.
    await transaction
      .update(identityTokens)
      .set({ consumedAt })
      .where(
        and(
          eq(identityTokens.userId, user.id),
          eq(identityTokens.purpose, 'email_verification'),
          isNull(identityTokens.consumedAt),
        ),
      );

    return true;
  });
}

/**
 * Creates a fresh verification token for an eligible pending account.
 * Existing links remain untouched and valid until they expire or are consumed.
 */
export async function createResendVerification(
  db: DatabaseClient['db'],
  input: ResendVerificationRequestBody,
): Promise<{ recipient: string; rawToken: string } | undefined> {
  const normalizedEmail = normalizeEmail(input.email);

  return db.transaction(async (transaction) => {
    const users = await transaction
      .select({
        id: identityUsers.id,
        deliveryEmail: identityUsers.deliveryEmail,
        status: identityUsers.status,
        emailVerifiedAt: identityUsers.emailVerifiedAt,
      })
      .from(identityUsers)
      .where(eq(identityUsers.normalizedEmail, normalizedEmail))
      .for('update')
      .limit(1);

    const user = users[0];

    if (!user || user.status !== 'pending_verification' || user.emailVerifiedAt !== null) {
      return undefined;
    }

    const verificationToken = generateEmailVerificationToken();
    const now = new Date();

    await transaction.insert(identityTokens).values({
      userId: user.id,
      purpose: 'email_verification',
      tokenDigest: verificationToken.digest,
      expiresAt: new Date(now.getTime() + VERIFICATION_TOKEN_LIFETIME_MS),
    });

    return {
      recipient: user.deliveryEmail,
      rawToken: verificationToken.rawToken,
    };
  });
}

function normalizeEmail(email: string): string {
  return email.trim().normalize('NFC').toLowerCase();
}
