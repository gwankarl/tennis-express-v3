import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ENVELOPE_VERSION = 'v1';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface MfaSeedContext {
  userId: string;
  factorId: string;
}

export interface EncryptedMfaSeed {
  secretCiphertext: string;
  keyVersion: string;
}

/** Avoid exposing key material, seed material, or ciphertext through errors. */
export class MfaCryptoError extends Error {
  constructor() {
    super('Administrator MFA seed protection failed.');
    this.name = 'MfaCryptoError';
  }
}

/**
 * Encrypts a Base32 TOTP seed with AES-256-GCM and binds it to its user and
 * factor IDs. Persist the returned ciphertext and key version only.
 */
export function encryptMfaSeed(
  seed: string,
  keyBase64: string,
  keyVersion: string,
  context: MfaSeedContext,
): EncryptedMfaSeed {
  const key = decodeKey(keyBase64);

  if (!seed || !keyVersion.trim() || !context.userId || !context.factorId) {
    throw new MfaCryptoError();
  }

  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(associatedData(context, keyVersion));

    const ciphertext = Buffer.concat([cipher.update(seed, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      secretCiphertext: [
        ENVELOPE_VERSION,
        iv.toString('base64url'),
        authTag.toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.'),
      keyVersion,
    };
  } catch {
    throw new MfaCryptoError();
  }
}

/** Decrypts a stored seed only when its context and authentication tag match. */
export function decryptMfaSeed(
  secretCiphertext: string,
  keyBase64: string,
  keyVersion: string,
  context: MfaSeedContext,
): string {
  const key = decodeKey(keyBase64);
  const [version, ivText, authTagText, ciphertextText, extra] = secretCiphertext.split('.');

  if (
    version !== ENVELOPE_VERSION ||
    !ivText ||
    !authTagText ||
    ciphertextText === undefined ||
    extra !== undefined
  ) {
    throw new MfaCryptoError();
  }

  try {
    const iv = Buffer.from(ivText, 'base64url');
    const authTag = Buffer.from(authTagText, 'base64url');
    const ciphertext = Buffer.from(ciphertextText, 'base64url');

    if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES || ciphertext.length === 0) {
      throw new MfaCryptoError();
    }

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(associatedData(context, keyVersion));
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new MfaCryptoError();
  }
}

function decodeKey(keyBase64: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(keyBase64)) {
    throw new MfaCryptoError();
  }

  const key = Buffer.from(keyBase64, 'base64');

  if (key.length !== 32 || key.toString('base64') !== keyBase64) {
    throw new MfaCryptoError();
  }

  return key;
}

function associatedData(context: MfaSeedContext, keyVersion: string): Buffer {
  return Buffer.from(`${context.userId}:${context.factorId}:${keyVersion}`, 'utf8');
}
