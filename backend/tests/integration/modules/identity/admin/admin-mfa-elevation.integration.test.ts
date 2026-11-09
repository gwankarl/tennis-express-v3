import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../../../src/app.js';
import { requireWorkspaceAccess } from '../../../../../src/http/guards/authorize-workspace.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../../src/infrastructure/database/client.js';
import { hashPassword } from '../../../../../src/modules/identity/passwords/credentials.js';
import { createSession } from '../../../../../src/modules/identity/sessions/session.service.js';
import { digestIdentityToken } from '../../../../../src/modules/identity/token.js';
import { encryptMfaSeed } from '../../../../../src/modules/identity/admin/mfa-crypto.js';
import {
  createTotpCode,
  generateTotpSecret,
} from '../../../../../src/modules/identity/admin/totp.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../../helpers/test-database.js';

const runId = randomUUID();
const password = 'synthetic administrator passphrase';
const mfaConfig = {
  encryptionKey: Buffer.alloc(32, 0x31).toString('base64'),
  keyVersion: 'integration-v1',
  attemptHmacKey: Buffer.alloc(32, 0x42).toString('base64'),
};
const fixtureUserIds: string[] = [];

let database: DatabaseClient | undefined;
let appDatabase: DatabaseClient | undefined;
let app: ReturnType<typeof buildApp> | undefined;
let testDatabaseVerified = false;
let userSequence = 0;
let ipSequence = 1;

function getDatabase(): DatabaseClient {
  if (!database) throw new Error('Test database was not initialized.');
  return database;
}

function getApp(): NonNullable<typeof app> {
  if (!app) throw new Error('MFA elevation test app was not initialized.');
  return app;
}

function nextIpAddress(): string {
  const namespace = runId.replaceAll('-', '');
  const address = `2001:db8:${namespace.slice(0, 4)}:${namespace.slice(4, 8)}::${ipSequence}`;
  ipSequence = (ipSequence % 250) + 1;
  return address;
}

async function createAccount(options: { administrator?: boolean } = {}): Promise<{
  id: string;
  email: string;
  totpSecret: string;
}> {
  userSequence += 1;
  const id = randomUUID();
  const email = `mfa-elevation-${runId}-${userSequence}@example.test`;
  fixtureUserIds.push(id);

  await getDatabase().pool.query(
    `INSERT INTO identity_users
       (id, delivery_email, normalized_email, status, email_verified_at)
     VALUES ($1, $2, $2, 'active', now())`,
    [id, email],
  );

  await getDatabase().pool.query(
    `INSERT INTO identity_credentials (user_id, password_hash)
     VALUES ($1, $2)`,
    [id, await hashPassword(password)],
  );

  if (options.administrator !== false) {
    await getDatabase().pool.query(
      `INSERT INTO identity_user_permissions (user_id, permission)
       VALUES ($1, 'administrator')`,
      [id],
    );
  }

  const factorId = randomUUID();
  const totpSecret = generateTotpSecret();
  const encrypted = encryptMfaSeed(totpSecret, mfaConfig.encryptionKey, mfaConfig.keyVersion, {
    userId: id,
    factorId,
  });

  await getDatabase().pool.query(
    `INSERT INTO identity_mfa_factors
       (id, user_id, status, secret_ciphertext, key_version, confirmed_at)
     VALUES ($1, $2, 'active', $3, $4, now())`,
    [factorId, id, encrypted.secretCiphertext, encrypted.keyVersion],
  );

  return { id, email, totpSecret };
}

async function createUserSession(userId: string) {
  const session = await createSession(getDatabase().db, userId);
  if (!session) throw new Error('Could not create the synthetic session.');
  return session;
}

async function postMfa(path: string, sessionToken: string, payload: Record<string, string>) {
  return getApp().inject({
    method: 'POST',
    url: path,
    remoteAddress: nextIpAddress(),
    headers: { authorization: `Bearer ${sessionToken}` },
    payload,
  });
}

async function startChallenge(sessionToken: string) {
  const response = await postMfa('/api/v1/admin/mfa/elevation/challenge', sessionToken, {
    password,
  });

  expect(response.statusCode, response.body).toBe(200);

  return response.json<{
    data: { challenge: string; expiresAt: string };
  }>().data;
}

async function confirmChallenge(sessionToken: string, challenge: string, totpCode: string) {
  return postMfa('/api/v1/admin/mfa/elevation/confirm', sessionToken, {
    challenge,
    code: totpCode,
  });
}

function currentTotpCode(secret: string): string {
  return createTotpCode(secret, Math.floor(Date.now() / 30_000));
}

async function protectedRequest(path: string, sessionToken: string) {
  return getApp().inject({
    method: 'GET',
    url: path,
    remoteAddress: nextIpAddress(),
    headers: { authorization: `Bearer ${sessionToken}` },
  });
}

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(database.pool);
  testDatabaseVerified = true;

  appDatabase = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(appDatabase.pool);

  app = buildApp({
    database: appDatabase,
    adminMfa: mfaConfig,
  });

  app.get('/__test/admin-only', { preHandler: requireWorkspaceAccess('admin') }, async () => ({
    ok: true,
  }));
  app.get('/__test/buyer-only', { preHandler: requireWorkspaceAccess('buyer') }, async () => ({
    ok: true,
  }));
});

afterAll(async () => {
  try {
    await app?.close();

    if (database && testDatabaseVerified && fixtureUserIds.length > 0) {
      await database.pool.query(
        `DELETE FROM identity_admin_audit_events
          WHERE target_user_id = ANY($1::uuid[])`,
        [fixtureUserIds],
      );
      await database.pool.query(
        `DELETE FROM identity_users
          WHERE id = ANY($1::uuid[])`,
        [fixtureUserIds],
      );
    }
  } finally {
    await Promise.allSettled([database?.close(), appDatabase?.close()]);
  }
});

describe('administrator MFA elevation', () => {
  it('elevates only the current session, rotates its token, and rejects the old token', async () => {
    const account = await createAccount();
    const firstSession = await createUserSession(account.id);
    const secondSession = await createUserSession(account.id);

    const before = await protectedRequest('/api/v1/me/workspaces', firstSession.rawToken);
    expect(before.statusCode).toBe(200);
    expect(before.json().data.adminEntryState).toBe('mfa_required');

    const challenge = await startChallenge(firstSession.rawToken);
    const confirmation = await confirmChallenge(
      firstSession.rawToken,
      challenge.challenge,
      currentTotpCode(account.totpSecret),
    );

    expect(confirmation.statusCode, confirmation.body).toBe(200);
    expect(confirmation.headers['cache-control']).toContain('no-store');

    const elevated = confirmation.json<{
      data: {
        sessionToken: string;
        tokenType: 'Bearer';
        expiresAt: string;
        elevatedUntil: string;
      };
    }>().data;

    expect(elevated.tokenType).toBe('Bearer');
    expect(elevated.sessionToken).not.toBe(firstSession.rawToken);
    expect(new Date(elevated.elevatedUntil).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(elevated.elevatedUntil).getTime()).toBeLessThanOrEqual(
      new Date(elevated.expiresAt).getTime(),
    );

    const oldCredential = await protectedRequest('/__test/admin-only', firstSession.rawToken);
    expect(oldCredential.statusCode).toBe(401);

    const elevatedAdminRequest = await protectedRequest(
      '/__test/admin-only',
      elevated.sessionToken,
    );
    expect(elevatedAdminRequest.statusCode).toBe(200);

    const secondSessionAdminRequest = await protectedRequest(
      '/__test/admin-only',
      secondSession.rawToken,
    );
    expect(secondSessionAdminRequest.statusCode).toBe(403);

    const secondSessionWorkspaces = await protectedRequest(
      '/api/v1/me/workspaces',
      secondSession.rawToken,
    );
    expect(secondSessionWorkspaces.statusCode).toBe(200);
    expect(secondSessionWorkspaces.json().data.adminEntryState).toBe('mfa_required');

    const elevatedWorkspaces = await protectedRequest(
      '/api/v1/me/workspaces',
      elevated.sessionToken,
    );
    expect(elevatedWorkspaces.statusCode).toBe(200);
    expect(elevatedWorkspaces.json().data.adminEntryState).toBe('available');
  });

  it('rejects a challenge submitted from another session belonging to the same user', async () => {
    const account = await createAccount();
    const initiatingSession = await createUserSession(account.id);
    const otherSession = await createUserSession(account.id);
    const challenge = await startChallenge(initiatingSession.rawToken);

    const response = await confirmChallenge(
      otherSession.rawToken,
      challenge.challenge,
      currentTotpCode(account.totpSecret),
    );

    expect(response.statusCode).toBe(400);
  });

  it('rejects an expired challenge', async () => {
    const account = await createAccount();
    const session = await createUserSession(account.id);
    const challenge = await startChallenge(session.rawToken);

    await getDatabase().pool.query(
      `UPDATE identity_admin_mfa_elevation_challenges
          SET issued_at = now() - interval '5 minutes 1 second',
            expires_at = now() - interval '1 second'
        WHERE challenge_digest = $1`,
      [digestIdentityToken(challenge.challenge)],
    );

    const response = await confirmChallenge(
      session.rawToken,
      challenge.challenge,
      currentTotpCode(account.totpSecret),
    );

    expect(response.statusCode).toBe(400);
  });

  it('rejects a consumed challenge even when submitted with the rotated credential', async () => {
    const account = await createAccount();
    const session = await createUserSession(account.id);
    const challenge = await startChallenge(session.rawToken);
    const code = currentTotpCode(account.totpSecret);

    const firstConfirmation = await confirmChallenge(session.rawToken, challenge.challenge, code);
    expect(firstConfirmation.statusCode).toBe(200);

    const rotatedToken = firstConfirmation.json<{
      data: { sessionToken: string };
    }>().data.sessionToken;

    const replay = await confirmChallenge(rotatedToken, challenge.challenge, code);
    expect(replay.statusCode).toBe(400);
  });

  it('rejects reuse of a previously accepted TOTP time step', async () => {
    const account = await createAccount();
    const session = await createUserSession(account.id);
    const challenge = await startChallenge(session.rawToken);

    const firstConfirmation = await confirmChallenge(
      session.rawToken,
      challenge.challenge,
      currentTotpCode(account.totpSecret),
    );
    expect(firstConfirmation.statusCode).toBe(200);

    const rotatedToken = firstConfirmation.json<{
      data: { sessionToken: string };
    }>().data.sessionToken;

    const factor = await getDatabase().pool.query<{
      last_accepted_time_step: number;
    }>(
      `SELECT last_accepted_time_step
         FROM identity_mfa_factors
        WHERE user_id = $1 AND status = 'active'`,
      [account.id],
    );
    const acceptedStep = factor.rows[0]?.last_accepted_time_step;
    expect(acceptedStep).toBeTypeOf('number');

    const secondChallenge = await startChallenge(rotatedToken);
    const replayedCode = createTotpCode(account.totpSecret, acceptedStep!);
    const replay = await confirmChallenge(rotatedToken, secondChallenge.challenge, replayedCode);

    expect(replay.statusCode).toBe(400);
  });

  it('allows only one of two concurrent confirmations to rotate the session', async () => {
    const account = await createAccount();
    const session = await createUserSession(account.id);
    const challenge = await startChallenge(session.rawToken);
    const code = currentTotpCode(account.totpSecret);

    const responses = await Promise.all([
      confirmChallenge(session.rawToken, challenge.challenge, code),
      confirmChallenge(session.rawToken, challenge.challenge, code),
    ]);

    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(
      responses.some((response) => response.statusCode === 401 || response.statusCode === 403),
    ).toBe(true);
  });

  it('limits elevation challenges to five attempts per account in fifteen minutes', async () => {
    const account = await createAccount();
    const session = await createUserSession(account.id);
    const path = '/api/v1/admin/mfa/elevation/challenge';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await getApp().inject({
        method: 'POST',
        url: path,
        remoteAddress: nextIpAddress(),
        headers: { authorization: `Bearer ${session.rawToken}` },
        payload: { password },
      });

      expect(response.statusCode, response.body).toBe(200);
    }

    const limited = await getApp().inject({
      method: 'POST',
      url: path,
      remoteAddress: nextIpAddress(),
      headers: { authorization: `Bearer ${session.rawToken}` },
      payload: { password },
    });

    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('denies challenge creation when the administrator permission is missing', async () => {
    const account = await createAccount({ administrator: false });
    const session = await createUserSession(account.id);

    const response = await postMfa('/api/v1/admin/mfa/elevation/challenge', session.rawToken, {
      password,
    });

    expect(response.statusCode).toBe(403);
  });

  it('denies confirmation after the administrator permission is revoked', async () => {
    const account = await createAccount();
    const session = await createUserSession(account.id);
    const challenge = await startChallenge(session.rawToken);

    await getDatabase().pool.query(
      `DELETE FROM identity_user_permissions
        WHERE user_id = $1 AND permission = 'administrator'`,
      [account.id],
    );

    const confirmation = await confirmChallenge(
      session.rawToken,
      challenge.challenge,
      currentTotpCode(account.totpSecret),
    );
    expect(confirmation.statusCode).toBe(403);

    const adminRequest = await protectedRequest('/__test/admin-only', session.rawToken);
    expect(adminRequest.statusCode).toBe(403);

    const buyerRequest = await protectedRequest('/__test/buyer-only', session.rawToken);
    expect(buyerRequest.statusCode).toBe(200);
  });

  it('denies elevation while the post-recovery Admin hold is active', async () => {
    const account = await createAccount();
    const session = await createUserSession(account.id);

    await getDatabase().pool.query(
      `INSERT INTO identity_mfa_recoveries
         (user_id, method, status, requested_at, completed_at, admin_hold_until)
       VALUES (
         $1,
         'recovery_code',
         'completed',
         now(),
         now(),
         now() + interval '24 hours'
       )`,
      [account.id],
    );

    const response = await postMfa('/api/v1/admin/mfa/elevation/challenge', session.rawToken, {
      password,
    });

    expect(response.statusCode).toBe(403);
  });

  it('denies Admin access after elevation expires while Buyer access remains available', async () => {
    const account = await createAccount();
    const session = await createUserSession(account.id);
    const challenge = await startChallenge(session.rawToken);
    const confirmation = await confirmChallenge(
      session.rawToken,
      challenge.challenge,
      currentTotpCode(account.totpSecret),
    );

    expect(confirmation.statusCode).toBe(200);
    const elevatedToken = confirmation.json<{
      data: { sessionToken: string };
    }>().data.sessionToken;

    await getDatabase().pool.query(
      `UPDATE identity_sessions
          SET admin_mfa_elevated_at = now() - interval '2 minutes',
              admin_mfa_elevated_until = now() - interval '1 minute'
        WHERE id = $1`,
      [session.sessionId],
    );

    const adminRequest = await protectedRequest('/__test/admin-only', elevatedToken);
    expect(adminRequest.statusCode).toBe(403);

    const workspaces = await protectedRequest('/api/v1/me/workspaces', elevatedToken);
    expect(workspaces.statusCode).toBe(200);
    expect(workspaces.json().data.adminEntryState).toBe('mfa_required');

    const buyerRequest = await protectedRequest('/__test/buyer-only', elevatedToken);
    expect(buyerRequest.statusCode).toBe(200);
  });
});
