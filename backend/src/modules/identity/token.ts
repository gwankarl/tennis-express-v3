import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;

export interface GeneratedIdentityToken {
  /** Raw token for delivery to the user. Do not log or persist this value. */
  rawToken: string;
  /** Lowercase SHA-256 hex digest for the database token_digest column. */
  digest: string;
}

function generateToken(): GeneratedIdentityToken {
  const rawToken = randomBytes(TOKEN_BYTES).toString('base64url');

  return {
    rawToken,
    digest: digestIdentityToken(rawToken),
  };
}

/** Generates a random bearer token for a session. */
export function generateSessionToken(): GeneratedIdentityToken {
  return generateToken();
}

/** Generates a random token for email verification. */
export function generateEmailVerificationToken(): GeneratedIdentityToken {
  return generateToken();
}

/** Generates a random token for password recovery. */
export function generatePasswordRecoveryToken(): GeneratedIdentityToken {
  return generateToken();
}

/** Returns the lowercase SHA-256 hex digest used by the identity token tables. */
export function digestIdentityToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Returns true when the token has expired at or before `now`.
 * Purpose and single-use checks belong to the identity service.
 */
export function isTokenExpired(expiresAt: Date, now: Date): boolean {
  const expiryTime = expiresAt.getTime();
  const currentTime = now.getTime();

  if (!Number.isFinite(expiryTime) || !Number.isFinite(currentTime)) {
    throw new RangeError('Token expiry and current time must be valid dates.');
  }

  return currentTime >= expiryTime;
}
