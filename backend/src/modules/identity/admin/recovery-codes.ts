import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 16;

export interface GeneratedRecoveryCodes {
  /** Display these once to the administrator. Never log or store them. */
  rawCodes: string[];
  /** Persist these digests, not rawCodes. */
  digests: string[];
}

/** Creates ten independent 128-bit, single-use recovery codes by default. */
export function generateRecoveryCodes(count = DEFAULT_RECOVERY_CODE_COUNT): GeneratedRecoveryCodes {
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) {
    throw new RangeError('Recovery-code count is invalid.');
  }

  const rawCodes = Array.from({ length: count }, () =>
    formatCode(randomBytes(RECOVERY_CODE_BYTES)),
  );
  const digests = rawCodes.map(digestRecoveryCode);

  return { rawCodes, digests };
}

/** Hashes the normalized 32-character hexadecimal recovery-code representation. */
export function digestRecoveryCode(rawCode: string): string {
  const normalized = rawCode.replace(/[\s-]/gu, '').toUpperCase();

  if (!/^[A-F0-9]{32}$/u.test(normalized)) {
    throw new Error('Recovery code is invalid.');
  }

  return createHash('sha256').update(normalized, 'ascii').digest('hex');
}

function formatCode(bytes: Buffer): string {
  const hex = bytes.toString('hex').toUpperCase();

  return hex.match(/.{1,8}/gu)!.join('-');
}
