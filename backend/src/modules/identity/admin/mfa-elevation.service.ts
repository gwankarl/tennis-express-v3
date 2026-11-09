import type { Pool, PoolClient } from 'pg';
import type { AdminMfaConfig } from '../../../config/env.js';
import { verifyPassword } from '../passwords/credentials.js';
import { digestIdentityToken, generateSessionToken } from '../token.js';
import { consumeMfaAttempt } from './mfa-attempts.service.js';
import { decryptMfaSeed } from './mfa-crypto.js';
import { verifyTotpCode } from './totp.js';

const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
const ELEVATION_LIFETIME_MS = 15 * 60 * 1000;

export type AdminMfaElevationErrorCode =
  | 'not_authorized'
  | 'invalid_credentials'
  | 'invalid_challenge'
  | 'invalid_code'
  | 'attempts_blocked'
  | 'service_unavailable';

export class AdminMfaElevationError extends Error {
  constructor(
    readonly code: AdminMfaElevationErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(safeMessage(code));
    this.name = 'AdminMfaElevationError';
  }
}

interface ElevationInput {
  pool: Pool;
  config: AdminMfaConfig;
  userId: string;
  sessionId: string;
  /** Current bearer credential, used only to ensure it has not been rotated. */
  sessionToken: string;
  ipAddress: string;
  requestId?: string;
  now?: Date;
}

export interface StartAdminMfaElevationInput extends ElevationInput {
  password: string;
}

export interface ConfirmAdminMfaElevationInput extends ElevationInput {
  challenge: string;
  code: string;
}

export interface AdminMfaElevationChallenge {
  challenge: string;
  expiresAt: Date;
}

export interface AdminMfaElevationResult {
  /** Return once to the caller so it can replace the old session credential. */
  sessionToken: string;
  absoluteExpiresAt: Date;
  elevatedUntil: Date;
}

/**
 * Verifies the current password and issues a five-minute challenge bound to
 * the authenticated user and the exact current session credential.
 */
export async function startAdminMfaElevation(
  input: StartAdminMfaElevationInput,
): Promise<AdminMfaElevationChallenge> {
  const now = input.now ?? new Date();
  assertValidTime(now);
  await requireAllowedAttempt(input, now);

  try {
    const initial = await input.pool.query<{ password_hash: string }>(
      `SELECT password_hash
         FROM identity_credentials
        WHERE user_id = $1`,
      [input.userId],
    );
    const initialPasswordHash = initial.rows[0]?.password_hash;

    if (
      !initialPasswordHash ||
      !(await verifyPasswordSafely(input.password, initialPasswordHash))
    ) {
      throw new AdminMfaElevationError('invalid_credentials');
    }

    const generated = generateSessionToken();
    const expiresAt = new Date(now.getTime() + CHALLENGE_LIFETIME_MS);
    const client = await connect(input.pool);

    try {
      await client.query('BEGIN');
      await lockEligibleUser(client, input.userId);
      await lockCurrentSession(client, input, now);

      const credential = await client.query<{ password_hash: string }>(
        `SELECT password_hash
           FROM identity_credentials
          WHERE user_id = $1
          FOR UPDATE`,
        [input.userId],
      );

      if (credential.rows[0]?.password_hash !== initialPasswordHash) {
        throw new AdminMfaElevationError('invalid_credentials');
      }

      await requireAdministratorGrant(client, input.userId);
      await requireRecoveryHoldEnded(client, input.userId, now);
      await requireActiveFactor(client, input.userId);

      await client.query(
        `INSERT INTO identity_admin_mfa_elevation_challenges
           (user_id, session_id, challenge_digest, issued_at, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.userId, input.sessionId, generated.digest, now, expiresAt],
      );

      await client.query('COMMIT');
      return { challenge: generated.rawToken, expiresAt };
    } catch (error) {
      await rollback(client);
      throw normalizeError(error);
    } finally {
      client.release();
    }
  } catch (error) {
    const normalized = normalizeError(error);
    await recordFailure(input, now);
    throw normalized;
  }
}

/**
 * Consumes the session-bound challenge and a previously unused TOTP step.
 * Rotates the session credential and records its bounded elevation atomically.
 */
export async function confirmAdminMfaElevation(
  input: ConfirmAdminMfaElevationInput,
): Promise<AdminMfaElevationResult> {
  const now = input.now ?? new Date();
  assertValidTime(now);
  await requireAllowedAttempt(input, now);

  const generatedSession = generateSessionToken();
  const client = await connect(input.pool);

  try {
    await client.query('BEGIN');
    await lockEligibleUser(client, input.userId);
    const session = await lockCurrentSession(client, input, now);
    await requireAdministratorGrant(client, input.userId);
    await requireRecoveryHoldEnded(client, input.userId, now);

    const factorResult = await client.query<{
      id: string;
      secret_ciphertext: string;
      key_version: string;
      last_accepted_time_step: number | null;
    }>(
      `SELECT id, secret_ciphertext, key_version, last_accepted_time_step
         FROM identity_mfa_factors
        WHERE user_id = $1
          AND status = 'active'
          AND revoked_at IS NULL
        FOR UPDATE`,
      [input.userId],
    );
    const factor = factorResult.rows[0];

    if (!factor) {
      throw new AdminMfaElevationError('not_authorized');
    }

    const challengeResult = await client.query<{
      id: string;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT id, expires_at, consumed_at
         FROM identity_admin_mfa_elevation_challenges
        WHERE user_id = $1
          AND session_id = $2
          AND challenge_digest = $3
        FOR UPDATE`,
      [input.userId, input.sessionId, digestIdentityToken(input.challenge)],
    );
    const challenge = challengeResult.rows[0];

    if (
      !challenge ||
      challenge.consumed_at !== null ||
      challenge.expires_at.getTime() <= now.getTime()
    ) {
      throw new AdminMfaElevationError('invalid_challenge');
    }

    let secret: string;

    try {
      secret = decryptMfaSeed(
        factor.secret_ciphertext,
        input.config.encryptionKey,
        factor.key_version,
        { userId: input.userId, factorId: factor.id },
      );
    } catch {
      throw new AdminMfaElevationError('service_unavailable');
    }

    const acceptedStep = verifyTotpCode(secret, input.code, now);

    if (
      acceptedStep === null ||
      (factor.last_accepted_time_step !== null && acceptedStep <= factor.last_accepted_time_step)
    ) {
      throw new AdminMfaElevationError('invalid_code');
    }

    const consumed = await client.query(
      `UPDATE identity_admin_mfa_elevation_challenges
          SET consumed_at = $2
        WHERE id = $1
          AND consumed_at IS NULL
          AND expires_at > $2
        RETURNING id`,
      [challenge.id, now],
    );

    if (consumed.rowCount !== 1) {
      throw new AdminMfaElevationError('invalid_challenge');
    }

    const factorUpdated = await client.query(
      `UPDATE identity_mfa_factors
          SET last_accepted_time_step = $2,
              updated_at = $3
        WHERE id = $1
          AND status = 'active'
          AND revoked_at IS NULL
          AND (last_accepted_time_step IS NULL OR last_accepted_time_step < $2)
        RETURNING id`,
      [factor.id, acceptedStep, now],
    );

    if (factorUpdated.rowCount !== 1) {
      throw new AdminMfaElevationError('invalid_code');
    }

    const elevatedUntil = new Date(
      Math.min(now.getTime() + ELEVATION_LIFETIME_MS, session.absolute_expires_at.getTime()),
    );

    const rotated = await client.query<{ absolute_expires_at: Date }>(
      `UPDATE identity_sessions
          SET token_digest = $4,
              admin_mfa_elevated_at = $5,
              admin_mfa_elevated_until = $6
        WHERE id = $1
          AND user_id = $2
          AND token_digest = $3
          AND revoked_at IS NULL
          AND idle_expires_at > $5
          AND absolute_expires_at > $5
        RETURNING absolute_expires_at`,
      [
        input.sessionId,
        input.userId,
        digestIdentityToken(input.sessionToken),
        generatedSession.digest,
        now,
        elevatedUntil,
      ],
    );

    const rotatedSession = rotated.rows[0];

    if (!rotatedSession) {
      throw new AdminMfaElevationError('not_authorized');
    }

    await client.query(
      `INSERT INTO identity_admin_audit_events
         (event_type, outcome, actor_type, actor_user_id, target_user_id,
          session_id, request_id, occurred_at)
       VALUES ('mfa_elevation_succeeded', 'success', 'user', $1, $1, $2, $3, $4)`,
      [input.userId, input.sessionId, input.requestId ?? null, now],
    );

    await client.query('COMMIT');

    return {
      sessionToken: generatedSession.rawToken,
      absoluteExpiresAt: rotatedSession.absolute_expires_at,
      elevatedUntil,
    };
  } catch (error) {
    await rollback(client);
    const normalized = normalizeError(error);

    if (
      normalized.code === 'not_authorized' ||
      normalized.code === 'invalid_challenge' ||
      normalized.code === 'invalid_code'
    ) {
      await recordFailure(input, now);
    }

    throw normalized;
  } finally {
    client.release();
  }
}

async function requireAllowedAttempt(input: ElevationInput, now: Date): Promise<void> {
  let result;

  try {
    result = await consumeMfaAttempt({
      pool: input.pool,
      action: 'elevation',
      accountSubject: input.userId,
      ipAddress: input.ipAddress,
      hmacKeyBase64: input.config.attemptHmacKey,
      now,
    });
  } catch {
    throw new AdminMfaElevationError('service_unavailable');
  }

  if (!result.allowed) {
    throw new AdminMfaElevationError('attempts_blocked', result.retryAfterSeconds);
  }
}

async function lockEligibleUser(client: PoolClient, userId: string): Promise<void> {
  const result = await client.query(
    `SELECT id
       FROM identity_users
      WHERE id = $1
        AND status = 'active'
        AND email_verified_at IS NOT NULL
      FOR UPDATE`,
    [userId],
  );

  if (result.rowCount !== 1) {
    throw new AdminMfaElevationError('not_authorized');
  }
}

async function lockCurrentSession(
  client: PoolClient,
  input: ElevationInput,
  now: Date,
): Promise<{ absolute_expires_at: Date }> {
  const result = await client.query<{ absolute_expires_at: Date; token_digest: string }>(
    `SELECT token_digest, absolute_expires_at
       FROM identity_sessions
      WHERE id = $1
        AND user_id = $2
        AND token_digest = $3
        AND revoked_at IS NULL
        AND idle_expires_at > $4
        AND absolute_expires_at > $4
      FOR UPDATE`,
    [input.sessionId, input.userId, digestIdentityToken(input.sessionToken), now],
  );
  const session = result.rows[0];

  if (!session || session.token_digest !== digestIdentityToken(input.sessionToken)) {
    throw new AdminMfaElevationError('not_authorized');
  }

  return { absolute_expires_at: session.absolute_expires_at };
}

async function requireAdministratorGrant(client: PoolClient, userId: string): Promise<void> {
  const result = await client.query(
    `SELECT user_id
       FROM identity_user_permissions
      WHERE user_id = $1
        AND permission = 'administrator'
      FOR SHARE`,
    [userId],
  );

  if (result.rowCount !== 1) {
    throw new AdminMfaElevationError('not_authorized');
  }
}

async function requireRecoveryHoldEnded(
  client: PoolClient,
  userId: string,
  now: Date,
): Promise<void> {
  const result = await client.query(
    `SELECT id
       FROM identity_mfa_recoveries
      WHERE user_id = $1
        AND status = 'completed'
        AND admin_hold_until > $2
      LIMIT 1`,
    [userId, now],
  );

  if (result.rowCount !== 0) {
    throw new AdminMfaElevationError('not_authorized');
  }
}

async function requireActiveFactor(client: PoolClient, userId: string): Promise<void> {
  const result = await client.query(
    `SELECT id
       FROM identity_mfa_factors
      WHERE user_id = $1
        AND status = 'active'
        AND revoked_at IS NULL
      FOR SHARE`,
    [userId],
  );

  if (result.rowCount !== 1) {
    throw new AdminMfaElevationError('not_authorized');
  }
}

async function verifyPasswordSafely(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await verifyPassword(password, passwordHash);
  } catch {
    return false;
  }
}

async function recordFailure(input: ElevationInput, now: Date): Promise<void> {
  await input.pool
    .query(
      `INSERT INTO identity_admin_audit_events
         (event_type, outcome, actor_type, actor_user_id, target_user_id,
          session_id, request_id, occurred_at)
       VALUES ('mfa_elevation_failed', 'denied', 'user', $1, $1, $2, $3, $4)`,
      [input.userId, input.sessionId, input.requestId ?? null, now],
    )
    .catch(() => undefined);
}

async function connect(pool: Pool): Promise<PoolClient> {
  try {
    return await pool.connect();
  } catch {
    throw new AdminMfaElevationError('service_unavailable');
  }
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

function normalizeError(error: unknown): AdminMfaElevationError {
  return error instanceof AdminMfaElevationError
    ? error
    : new AdminMfaElevationError('service_unavailable');
}

function assertValidTime(now: Date): void {
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError('Administrator MFA elevation time is invalid.');
  }
}

function safeMessage(code: AdminMfaElevationErrorCode): string {
  switch (code) {
    case 'not_authorized':
      return 'Administrator MFA elevation is not authorized.';
    case 'invalid_credentials':
      return 'The supplied credentials could not be verified.';
    case 'invalid_challenge':
      return 'The MFA challenge is invalid or expired.';
    case 'invalid_code':
      return 'The verification code is invalid or expired.';
    case 'attempts_blocked':
      return 'Too many MFA attempts. Try again later.';
    case 'service_unavailable':
      return 'Administrator MFA elevation is temporarily unavailable.';
  }
}
