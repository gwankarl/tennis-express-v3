import { randomBytes, timingSafeEqual, argon2 } from 'node:crypto';

const ARGON2_PARAMETERS = {
  memory: 19_456,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
} as const;

const SALT_BYTES = 16;
const STORED_HASH_PATTERN =
  /^\$argon2id\$v=19\$m=19456,t=2,p=1\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function normalizePassword(password: string): Buffer {
  if (typeof password !== 'string') {
    throw new Error('Password must be a string.');
  }

  // NFC gives canonically equivalent Unicode input consistent treatment.
  // Do not trim or truncate the password.
  return Buffer.from(password.normalize('NFC'), 'utf8');
}

function encodePhcBase64(value: Buffer): string {
  return value.toString('base64').replace(/=+$/u, '');
}

function decodePhcBase64(value: string): Buffer | undefined {
  const decoded = Buffer.from(value, 'base64');

  if (encodePhcBase64(decoded) !== value) {
    return undefined;
  }

  return decoded;
}

function deriveKey(password: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      argon2(
        'argon2id',
        {
          ...ARGON2_PARAMETERS,
          message: password,
          nonce: salt,
        },
        (error, derivedKey) => {
          if (error) {
            reject(new Error('Password hashing failed.'));
            return;
          }

          resolve(derivedKey);
        },
      );
    } catch {
      reject(new Error('Password hashing failed.'));
    }
  });
}

/**
 * Hashes the full NFC-normalized UTF-8 password with Argon2id.
 * The returned PHC-style string includes the algorithm parameters and salt.
 */
export async function hashPassword(password: string): Promise<string> {
  const passwordBytes = normalizePassword(password);
  const salt = randomBytes(SALT_BYTES);
  const derivedKey = await deriveKey(passwordBytes, salt);

  return [
    '',
    'argon2id',
    'v=19',
    `m=${ARGON2_PARAMETERS.memory},t=${ARGON2_PARAMETERS.passes},p=${ARGON2_PARAMETERS.parallelism}`,
    encodePhcBase64(salt),
    encodePhcBase64(derivedKey),
  ].join('$');
}

/**
 * Verifies a password against this module's stored Argon2id format.
 * Malformed or unsupported stored hashes return false.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (typeof storedHash !== 'string') {
    return false;
  }

  const match = STORED_HASH_PATTERN.exec(storedHash);

  if (!match) {
    return false;
  }

  const salt = decodePhcBase64(match[1]!);
  const expectedKey = decodePhcBase64(match[2]!);

  if (!salt || salt.length !== SALT_BYTES || !expectedKey || expectedKey.length !== 32) {
    return false;
  }

  const passwordBytes = normalizePassword(password);
  const actualKey = await deriveKey(passwordBytes, salt);

  return timingSafeEqual(actualKey, expectedKey);
}
