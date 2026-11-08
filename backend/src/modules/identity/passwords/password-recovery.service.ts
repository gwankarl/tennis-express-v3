import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { DatabaseClient } from '../../../infrastructure/database/client.js';
import { identityUsers } from '../accounts/user.table.js';
import { normalizeEmail } from '../accounts/email-normalization.js';
import { revokeAllSessionsForUser } from '../sessions/session.service.js';
import { digestIdentityToken, generatePasswordRecoveryToken, isTokenExpired } from '../token.js';
import { identityTokens } from '../token.table.js';
import { checkPasswordPolicy } from './password-policy.js';
import { identityCredentials } from './credentials.table.js';
import { hashPassword } from './credentials.js';

const RESET_TOKEN_LIFETIME_MS = 30 * 60 * 1000;

export interface PasswordResetDelivery {
  recipient: string;
  rawToken: string;
}

/**
 * Creates a reset token only for an active, verified account.
 * The raw token is returned to the route for email delivery after commit.
 */
export async function createPasswordResetRequest(
  db: DatabaseClient['db'],
  email: string,
  now = new Date(),
): Promise<PasswordResetDelivery | undefined> {
  const normalizedEmail = normalizeEmail(email);

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

    if (!user || user.status !== 'active' || user.emailVerifiedAt === null) {
      return undefined;
    }

    const token = generatePasswordRecoveryToken();

    await transaction.insert(identityTokens).values({
      userId: user.id,
      purpose: 'password_reset',
      tokenDigest: token.digest,
      expiresAt: new Date(now.getTime() + RESET_TOKEN_LIFETIME_MS),
    });

    return {
      recipient: user.deliveryEmail,
      rawToken: token.rawToken,
    };
  });
}

/**
 * Resets the password atomically. Lock order is user, reset token, credential,
 * then sessions, matching login's user-row lock and session validation order.
 */
export async function resetPassword(
  db: DatabaseClient['db'],
  input: { token: string; password: string },
  now?: Date,
): Promise<boolean> {
  if (now && !Number.isFinite(now.getTime())) {
    throw new RangeError('Password reset time must be a valid date.');
  }

  if (!checkPasswordPolicy(input.password).valid) {
    return false;
  }

  const digest = digestIdentityToken(input.token);

  return db.transaction(async (transaction) => {
    // Discover the owner before locking. The token and account are re-read below.
    const candidates = await transaction
      .select({
        id: identityTokens.id,
        userId: identityTokens.userId,
      })
      .from(identityTokens)
      .where(
        and(eq(identityTokens.tokenDigest, digest), eq(identityTokens.purpose, 'password_reset')),
      )
      .limit(1);

    const candidate = candidates[0];

    if (!candidate) {
      return false;
    }

    // Login's createSession takes this same lock before checking the hash again.
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

    if (!user || user.status !== 'active' || user.emailVerifiedAt === null) {
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
          eq(identityTokens.userId, user.id),
          eq(identityTokens.tokenDigest, digest),
          eq(identityTokens.purpose, 'password_reset'),
        ),
      )
      .for('update')
      .limit(1);

    const token = tokens[0];

    const checkedAt = now ?? new Date();

    if (!token || token.consumedAt !== null || isTokenExpired(token.expiresAt, checkedAt)) {
      return false;
    }

    const credentials = await transaction
      .select({ userId: identityCredentials.userId })
      .from(identityCredentials)
      .where(eq(identityCredentials.userId, user.id))
      .for('update')
      .limit(1);

    if (!credentials[0]) {
      return false;
    }

    // Hash only after rate limiting and confirming a usable reset token.
    const passwordHash = await hashPassword(input.password);
    const mutationAt = now ?? new Date();
    const expiryCheck = now ?? sql`clock_timestamp()`;

    const consumed = await transaction
      .update(identityTokens)
      .set({ consumedAt: mutationAt })
      .where(
        and(
          eq(identityTokens.id, token.id),
          eq(identityTokens.userId, user.id),
          eq(identityTokens.purpose, 'password_reset'),
          isNull(identityTokens.consumedAt),
          gt(identityTokens.expiresAt, expiryCheck),
        ),
      )
      .returning({ id: identityTokens.id });

    if (consumed.length !== 1) {
      return false;
    }

    const updatedCredentials = await transaction
      .update(identityCredentials)
      .set({ passwordHash, updatedAt: mutationAt })
      .where(eq(identityCredentials.userId, user.id))
      .returning({ userId: identityCredentials.userId });

    if (updatedCredentials.length !== 1) {
      throw new Error('Password credential update failed.');
    }

    // Other reset links for this account become unusable in this transaction.
    await transaction
      .update(identityTokens)
      .set({ consumedAt: mutationAt })
      .where(
        and(
          eq(identityTokens.userId, user.id),
          eq(identityTokens.purpose, 'password_reset'),
          isNull(identityTokens.consumedAt),
        ),
      );

    // The user lock serializes this with login and session validation.
    await revokeAllSessionsForUser(transaction, user.id, mutationAt);

    return true;
  });
}
