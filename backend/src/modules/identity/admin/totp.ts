import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const DEFAULT_WINDOW_STEPS = 1;

/** Creates a 160-bit Base32 secret suitable for an authenticator app. */
export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

/**
 * Creates the otpauth URI for the protected enrollment response.
 * Callers must never log or persist this URI.
 */
export function createTotpProvisioningUri(secret: string, accountLabel: string): string {
  if (!decodeBase32(secret) || !accountLabel.trim()) {
    throw new Error('TOTP enrollment details are invalid.');
  }

  const issuer = 'Tennis Xpress';
  const label = `${issuer}:${accountLabel}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });

  return `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}`;
}

/** Computes a six-digit TOTP for a specific 30-second step, useful in tests. */
export function createTotpCode(secret: string, timeStep: number): string {
  if (!Number.isSafeInteger(timeStep) || timeStep < 0) {
    throw new RangeError('TOTP time step is invalid.');
  }

  return hotp(decodeBase32OrThrow(secret), timeStep);
}

/**
 * Returns the matching accepted time step, or null for an invalid code.
 * The caller must atomically require this step to exceed the factor's stored
 * lastAcceptedTimeStep before updating it, preventing replay across requests.
 */
export function verifyTotpCode(
  secret: string,
  submittedCode: string,
  now: Date,
  windowSteps = DEFAULT_WINDOW_STEPS,
): number | null {
  if (
    !/^\d{6}$/u.test(submittedCode) ||
    !Number.isFinite(now.getTime()) ||
    !Number.isSafeInteger(windowSteps) ||
    windowSteps < 0
  ) {
    return null;
  }

  const currentStep = Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
  let matchedStep: number | null = null;

  for (
    let step = Math.max(0, currentStep - windowSteps);
    step <= currentStep + windowSteps;
    step += 1
  ) {
    const expected = Buffer.from(hotp(decodeBase32OrThrow(secret), step), 'ascii');
    const actual = Buffer.from(submittedCode, 'ascii');

    if (timingSafeEqual(expected, actual)) {
      matchedStep = step;
    }
  }

  return matchedStep;
}

function hotp(secretBytes: Buffer, timeStep: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(timeStep));

  const digest = createHmac('sha1', secretBytes).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

function decodeBase32OrThrow(value: string): Buffer {
  const decoded = decodeBase32(value);

  if (!decoded) {
    throw new Error('TOTP secret is invalid.');
  }

  return decoded;
}

function encodeBase32(value: Buffer): string {
  let bits = 0;
  let accumulator = 0;
  let output = '';

  for (const byte of value) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(accumulator >>> bits) & 0x1f];
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(accumulator << (5 - bits)) & 0x1f];
  }

  return output;
}

function decodeBase32(value: string): Buffer | null {
  const normalized = value.replace(/=+$/u, '').toUpperCase();

  if (!normalized || !/^[A-Z2-7]+$/u.test(normalized)) {
    return null;
  }

  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];

  for (const character of normalized) {
    accumulator = (accumulator << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }

  return Buffer.from(bytes);
}
