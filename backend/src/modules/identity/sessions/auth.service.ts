import { eq } from 'drizzle-orm';
import type { DatabaseClient } from '../../../infrastructure/database/client.js';
import { identityUsers } from '../accounts/user.table.js';
import { normalizeEmail } from '../accounts/email-normalization.js';
import { identityCredentials } from '../passwords/credentials.table.js';
import { hashPassword, verifyPassword } from '../passwords/credentials.js';
import { createSession, type CreatedSession } from './session.service.js';

export interface LoginInput {
  email: string;
  password: string;
}

/**
 * Verifies a password and creates a session only if the account is eligible.
 * Unknown email addresses still take an Argon2 verification path.
 */
export async function login(
  db: DatabaseClient['db'],
  input: LoginInput,
): Promise<CreatedSession | undefined> {
  const dummyHash = await getDummyPasswordHash();
  const normalizedEmail = normalizeEmail(input.email);

  const rows = await db
    .select({
      userId: identityUsers.id,
      status: identityUsers.status,
      emailVerifiedAt: identityUsers.emailVerifiedAt,
      passwordHash: identityCredentials.passwordHash,
    })
    .from(identityUsers)
    .leftJoin(identityCredentials, eq(identityCredentials.userId, identityUsers.id))
    .where(eq(identityUsers.normalizedEmail, normalizedEmail))
    .limit(1);

  const account = rows[0];
  const hashToVerify = account?.passwordHash ?? dummyHash;
  const passwordMatches = await verifyPassword(input.password, hashToVerify);

  if (
    !account ||
    !account.passwordHash ||
    !passwordMatches ||
    account.status !== 'active' ||
    account.emailVerifiedAt === null
  ) {
    return undefined;
  }

  // createSession locks the user and rechecks eligibility and the credential
  // hash. If a password change or suspension won the race, it returns undefined.
  return createSession(db, account.userId, new Date(), account.passwordHash);
}

let dummyPasswordHashPromise: Promise<string> | undefined;

function getDummyPasswordHash(): Promise<string> {
  // This fixed synthetic password is never accepted for a real account.
  // Cache its Argon2id hash once so unknown-email attempts still verify a hash.
  dummyPasswordHashPromise ??= hashPassword('tennis-xpress-invalid-login-dummy-password');
  return dummyPasswordHashPromise;
}
