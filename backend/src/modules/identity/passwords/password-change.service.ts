import { and, eq, gt, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '../../../infrastructure/database/client.js';
import { identityUsers } from '../accounts/user.table.js';
import { identityCredentials } from './credentials.table.js';
import { verifyPassword, hashPassword } from './credentials.js';
import { checkPasswordPolicy } from './password-policy.js';
import { identitySessions } from '../sessions/session.table.js';
import { revokeAllSessionsForUser } from '../sessions/session.service.js';
import { identityTokens } from '../token.table.js';

export type PasswordChangeResult =
  | 'changed'
  | 'invalid_current_password'
  | 'session_expired'
  | 'account_ineligible'
  | 'credentials_changed';

export interface ChangePasswordInput {
  userId: string;
  sessionId: string;
  currentPassword: string;
  newPassword: string;
}

/**
 * Updates a password and invalidates reset links and sessions atomically.
 * The user row is the serialization point shared with login and password reset.
 */
export async function changePassword(
  db: DatabaseClient['db'],
  input: ChangePasswordInput,
  now?: Date,
): Promise<PasswordChangeResult> {
  if (now && !Number.isFinite(now.getTime())) {
    throw new RangeError('Password change time must be a valid date.');
  }

  if (!checkPasswordPolicy(input.newPassword).valid) {
    throw new Error('Password policy must be checked by the route.');
  }

  // Read and verify outside the transaction to avoid holding locks through
  // Argon2 verification. The hash is checked again after taking the user lock.
  const initialRows = await db
    .select({
      passwordHash: identityCredentials.passwordHash,
    })
    .from(identityUsers)
    .innerJoin(identityCredentials, eq(identityCredentials.userId, identityUsers.id))
    .where(eq(identityUsers.id, input.userId))
    .limit(1);

  const initial = initialRows[0];
  if (!initial || !(await verifyPassword(input.currentPassword, initial.passwordHash))) {
    return 'invalid_current_password';
  }

  return db.transaction(async (transaction) => {
    // Match login/reset lock ordering: user first, then session, credential.
    const users = await transaction
      .select({
        status: identityUsers.status,
        emailVerifiedAt: identityUsers.emailVerifiedAt,
      })
      .from(identityUsers)
      .where(eq(identityUsers.id, input.userId))
      .for('update')
      .limit(1);

    const user = users[0];
    if (!user || user.status !== 'active' || user.emailVerifiedAt === null) {
      return 'account_ineligible';
    }

    const sessions = await transaction
      .select({
        id: identitySessions.id,
        revokedAt: identitySessions.revokedAt,
        idleExpiresAt: identitySessions.idleExpiresAt,
        absoluteExpiresAt: identitySessions.absoluteExpiresAt,
      })
      .from(identitySessions)
      .where(
        and(eq(identitySessions.id, input.sessionId), eq(identitySessions.userId, input.userId)),
      )
      .for('update')
      .limit(1);

    const session = sessions[0];
    const checkedAt = now ?? new Date();
    if (
      !session ||
      session.revokedAt !== null ||
      checkedAt.getTime() >= session.idleExpiresAt.getTime() ||
      checkedAt.getTime() >= session.absoluteExpiresAt.getTime()
    ) {
      return 'session_expired';
    }

    const credentials = await transaction
      .select({ passwordHash: identityCredentials.passwordHash })
      .from(identityCredentials)
      .where(eq(identityCredentials.userId, input.userId))
      .for('update')
      .limit(1);

    const credential = credentials[0];
    if (!credential || credential.passwordHash !== initial.passwordHash) {
      return 'credentials_changed';
    }

    // Hash only after the request was rate limited and the current password
    // and session were verified. The user lock serializes this with login/reset.
    const passwordHash = await hashPassword(input.newPassword);

    const updated = await transaction
      .update(identityCredentials)
      .set({ passwordHash, updatedAt: checkedAt })
      .where(
        and(
          eq(identityCredentials.userId, input.userId),
          eq(identityCredentials.passwordHash, initial.passwordHash),
        ),
      )
      .returning({ userId: identityCredentials.userId });

    if (updated.length !== 1) {
      return 'credentials_changed';
    }

    // Consume every active reset link and revoke all sessions, including this one.
    await transaction
      .update(identityTokens)
      .set({ consumedAt: checkedAt })
      .where(
        and(
          eq(identityTokens.userId, input.userId),
          eq(identityTokens.purpose, 'password_reset'),
          isNull(identityTokens.consumedAt),
          gt(identityTokens.expiresAt, checkedAt),
        ),
      );

    await revokeAllSessionsForUser(transaction, input.userId, checkedAt);
    return 'changed';
  });
}
