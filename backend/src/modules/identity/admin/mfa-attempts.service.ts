import { createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

const ATTEMPT_LIMIT = 5;

export type MfaAttemptAction = 'enrollment' | 'recovery';
type MfaAttemptScope = 'account' | 'ip';

export interface ConsumeMfaAttemptInput {
  pool: Pool;
  action: MfaAttemptAction;
  /** Supply a user ID or normalized email. The raw value is never stored. */
  accountSubject: string;
  ipAddress: string;
  /** Base64 encoding of the configured 32-byte ADMIN_MFA_ATTEMPT_HMAC_KEY. */
  hmacKeyBase64: string;
  now?: Date;
}

export interface MfaAttemptResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Atomically reserves an account and IP attempt in PostgreSQL.
 *
 * The first five requests in a 15-minute window are allowed to reach
 * verification. The next request is denied and starts a 15-minute block.
 * Database upserts serialize concurrent requests across application instances.
 */
export async function consumeMfaAttempt(input: ConsumeMfaAttemptInput): Promise<MfaAttemptResult> {
  const now = input.now ?? new Date();

  if (!Number.isFinite(now.getTime()) || !input.accountSubject.trim() || !input.ipAddress.trim()) {
    throw new Error('MFA attempt context is invalid.');
  }

  const hmacKey = decodeHmacKey(input.hmacKeyBase64);
  const counters: Array<{
    scope: MfaAttemptScope;
    subject: string;
  }> = [
    { scope: 'account', subject: input.accountSubject },
    { scope: 'ip', subject: input.ipAddress },
  ];

  const client = await input.pool.connect();

  try {
    await client.query('BEGIN');

    let blockedUntil: Date | null = null;

    for (const counter of counters) {
      const subjectDigest = createHmac('sha256', hmacKey)
        .update(`${counter.scope}\0${counter.subject}`, 'utf8')
        .digest('hex');

      const result = await reserveCounter(client, counter.scope, input.action, subjectDigest, now);

      if (
        result.blockedUntil &&
        (!blockedUntil || result.blockedUntil.getTime() > blockedUntil.getTime())
      ) {
        blockedUntil = result.blockedUntil;
      }
    }

    await client.query('COMMIT');

    if (blockedUntil && blockedUntil.getTime() > now.getTime()) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil.getTime() - now.getTime()) / 1000)),
      };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  } catch {
    await client.query('ROLLBACK').catch(() => undefined);
    throw new Error('MFA attempt tracking is unavailable.');
  } finally {
    client.release();
  }
}

async function reserveCounter(
  client: PoolClient,
  scope: MfaAttemptScope,
  action: MfaAttemptAction,
  subjectDigest: string,
  now: Date,
): Promise<{ blockedUntil: Date | null }> {
  const result = await client.query<{ blocked_until: Date | null }>(
    `INSERT INTO identity_mfa_attempt_counters
       (scope, action, subject_digest, window_started_at, attempt_count, blocked_until, updated_at)
     VALUES ($1, $2, $3, $4, 1, NULL, $4)
     ON CONFLICT (scope, action, subject_digest)
     DO UPDATE SET
       window_started_at = CASE
         WHEN identity_mfa_attempt_counters.blocked_until <= $4
           OR identity_mfa_attempt_counters.window_started_at <= $4 - interval '15 minutes'
         THEN $4
         ELSE identity_mfa_attempt_counters.window_started_at
       END,
       attempt_count = CASE
         WHEN identity_mfa_attempt_counters.blocked_until <= $4
           OR identity_mfa_attempt_counters.window_started_at <= $4 - interval '15 minutes'
         THEN 1
         ELSE identity_mfa_attempt_counters.attempt_count + 1
       END,
       blocked_until = CASE
         WHEN identity_mfa_attempt_counters.blocked_until > $4
         THEN identity_mfa_attempt_counters.blocked_until
         WHEN identity_mfa_attempt_counters.blocked_until <= $4
           OR identity_mfa_attempt_counters.window_started_at <= $4 - interval '15 minutes'
         THEN NULL
         WHEN identity_mfa_attempt_counters.attempt_count >= $5
         THEN $4 + interval '15 minutes'
         ELSE NULL
       END,
       updated_at = $4
     RETURNING blocked_until`,
    [scope, action, subjectDigest, now, ATTEMPT_LIMIT],
  );

  const row = result.rows[0];

  if (!row) {
    throw new Error('MFA attempt counter was not updated.');
  }

  return { blockedUntil: row.blocked_until };
}

function decodeHmacKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(value)) {
    throw new Error('MFA attempt tracking is not configured.');
  }

  const key = Buffer.from(value, 'base64');

  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('MFA attempt tracking is not configured.');
  }

  return key;
}
