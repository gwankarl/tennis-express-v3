import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { identityCredentials } from '../passwords/credentials.table.js';
import type { DatabaseClient } from '../../../infrastructure/database/client.js';
import { identityUsers } from '../accounts/user.table.js';
import { digestIdentityToken, generateSessionToken } from '../token.js';
import { identitySessions } from './session.table.js';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const ABSOLUTE_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface AuthenticatedSession {
  sessionId: string;
  userId: string;
}

export type SessionValidation =
  | { kind: 'authenticated'; session: AuthenticatedSession }
  | { kind: 'account_restricted'; session: AuthenticatedSession };

export interface CreatedSession extends AuthenticatedSession {
  /** Return this to the caller that needs to issue the credential. Never persist or log it. */
  rawToken: string;
  absoluteExpiresAt: Date;
}

type SessionTransaction = Parameters<Parameters<DatabaseClient['db']['transaction']>[0]>[0];

export type SessionMutationExecutor = Pick<DatabaseClient['db'] | SessionTransaction, 'update'>;

function assertValidDate(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new RangeError('Session time must be a valid date.');
  }
}

function isAccountEligible(status: string, emailVerifiedAt: Date | null): boolean {
  return status === 'active' && emailVerifiedAt !== null;
}

/**
 * Creates a session only for a currently active, verified account.
 * The raw bearer token is returned once; only its digest is stored.
 */
export async function createSession(
  db: DatabaseClient['db'],
  userId: string,
  now = new Date(),
  expectedPasswordHash?: string,
): Promise<CreatedSession | undefined> {
  assertValidDate(now);

  return db.transaction(async (transaction) => {
    const users = await transaction
      .select({
        status: identityUsers.status,
        emailVerifiedAt: identityUsers.emailVerifiedAt,
      })
      .from(identityUsers)
      .where(eq(identityUsers.id, userId))
      .for('update')
      .limit(1);

    const user = users[0];

    if (!user || !isAccountEligible(user.status, user.emailVerifiedAt)) {
      return undefined;
    }

    if (expectedPasswordHash !== undefined) {
      const credentials = await transaction
        .select({ passwordHash: identityCredentials.passwordHash })
        .from(identityCredentials)
        .where(eq(identityCredentials.userId, userId))
        .limit(1);

      if (credentials[0]?.passwordHash !== expectedPasswordHash) {
        return undefined;
      }
    }

    const { rawToken, digest } = generateSessionToken();
    const absoluteExpiresAt = new Date(now.getTime() + ABSOLUTE_LIFETIME_MS);
    const idleExpiresAt = new Date(
      Math.min(now.getTime() + IDLE_TIMEOUT_MS, absoluteExpiresAt.getTime()),
    );

    const sessions = await transaction
      .insert(identitySessions)
      .values({
        userId,
        tokenDigest: digest,
        createdAt: now,
        lastSeenAt: now,
        idleExpiresAt,
        absoluteExpiresAt,
      })
      .returning({ sessionId: identitySessions.id });

    const session = sessions[0];

    if (!session) {
      throw new Error('Session creation did not return a session.');
    }

    return {
      sessionId: session.sessionId,
      userId,
      rawToken,
      absoluteExpiresAt,
    };
  });
}

/**
 * Validates the bearer token, current account eligibility, and both expiry
 * deadlines. Locks the user and session before renewing idle expiry so a
 * concurrent revocation or expiry cannot be undone.
 */
export async function validateSessionState(
  db: DatabaseClient['db'],
  rawToken: string,
  now?: Date,
): Promise<SessionValidation | undefined> {
  if (now) assertValidDate(now);

  if (rawToken.length === 0) {
    return undefined;
  }

  const digest = digestIdentityToken(rawToken);

  return db.transaction(async (transaction) => {
    // This read discovers the owner. The row is re-read under lock below.
    const candidates = await transaction
      .select({
        sessionId: identitySessions.id,
        userId: identitySessions.userId,
      })
      .from(identitySessions)
      .where(eq(identitySessions.tokenDigest, digest))
      .limit(1);

    const candidate = candidates[0];

    if (!candidate) {
      return undefined;
    }

    // Keep the lock order stable: user first, then session.
    const users = await transaction
      .select({
        status: identityUsers.status,
        emailVerifiedAt: identityUsers.emailVerifiedAt,
      })
      .from(identityUsers)
      .where(eq(identityUsers.id, candidate.userId))
      .for('update')
      .limit(1);

    const user = users[0];

    if (!user) {
      return undefined;
    }

    const accountRestricted = user.status === 'suspended';

    if (!accountRestricted && !isAccountEligible(user.status, user.emailVerifiedAt)) {
      return undefined;
    }

    const sessions = await transaction
      .select({
        sessionId: identitySessions.id,
        userId: identitySessions.userId,
        tokenDigest: identitySessions.tokenDigest,
        idleExpiresAt: identitySessions.idleExpiresAt,
        absoluteExpiresAt: identitySessions.absoluteExpiresAt,
        revokedAt: identitySessions.revokedAt,
      })
      .from(identitySessions)
      .where(
        and(
          eq(identitySessions.id, candidate.sessionId),
          eq(identitySessions.userId, candidate.userId),
          eq(identitySessions.tokenDigest, digest),
        ),
      )
      .for('update')
      .limit(1);

    const session = sessions[0];
    // Capture wall-clock time only after acquiring both row locks. A request
    // that waited past expiry must not validate using its earlier start time.
    const checkedAt = now ?? new Date();
    const databaseTime = now ?? sql`clock_timestamp()`;

    if (
      !session ||
      session.revokedAt !== null ||
      checkedAt.getTime() >= session.idleExpiresAt.getTime() ||
      checkedAt.getTime() >= session.absoluteExpiresAt.getTime()
    ) {
      return undefined;
    }

    if (accountRestricted) {
      return {
        kind: 'account_restricted',
        session: {
          sessionId: session.sessionId,
          userId: session.userId,
        },
      };
    }

    const renewedIdleExpiry = new Date(
      Math.min(checkedAt.getTime() + IDLE_TIMEOUT_MS, session.absoluteExpiresAt.getTime()),
    );

    const renewed = await transaction
      .update(identitySessions)
      .set({
        lastSeenAt: checkedAt,
        idleExpiresAt: renewedIdleExpiry,
      })
      .where(
        and(
          eq(identitySessions.id, session.sessionId),
          isNull(identitySessions.revokedAt),
          gt(identitySessions.idleExpiresAt, databaseTime),
          gt(identitySessions.absoluteExpiresAt, databaseTime),
        ),
      )
      .returning({ sessionId: identitySessions.id });

    if (renewed.length !== 1) {
      return undefined;
    }

    return {
      kind: 'authenticated',
      session: {
        sessionId: session.sessionId,
        userId: session.userId,
      },
    };
  });
}

/** Returns only sessions belonging to active, verified accounts. */
export async function validateSession(
  db: DatabaseClient['db'],
  rawToken: string,
  now?: Date,
): Promise<AuthenticatedSession | undefined> {
  const result = await validateSessionState(db, rawToken, now);
  return result?.kind === 'authenticated' ? result.session : undefined;
}

/** Revokes one session owned by the supplied user. Repeated calls are harmless. */
export async function revokeSession(
  db: SessionMutationExecutor,
  userId: string,
  sessionId: string,
  now = new Date(),
): Promise<boolean> {
  assertValidDate(now);

  const revoked = await db
    .update(identitySessions)
    .set({ revokedAt: now })
    .where(
      and(
        eq(identitySessions.id, sessionId),
        eq(identitySessions.userId, userId),
        isNull(identitySessions.revokedAt),
      ),
    )
    .returning({ sessionId: identitySessions.id });

  return revoked.length === 1;
}

/**
 * Revokes all active sessions for a user. Accepts either the root Drizzle
 * database or a transaction executor for atomic password-change workflows.
 */
export async function revokeAllSessionsForUser(
  db: SessionMutationExecutor,
  userId: string,
  now = new Date(),
): Promise<void> {
  assertValidDate(now);

  await db
    .update(identitySessions)
    .set({ revokedAt: now })
    .where(and(eq(identitySessions.userId, userId), isNull(identitySessions.revokedAt)));
}
