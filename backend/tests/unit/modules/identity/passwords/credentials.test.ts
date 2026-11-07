import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  verifyPassword,
} from '../../../../../src/modules/identity/passwords/credentials.js';

describe('identity password utilities', () => {
  it('hashes and verifies a correct Unicode password', async () => {
    const password = 'Tennis 🎾 — café e\u0301';
    const storedHash = await hashPassword(password);

    expect(storedHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
    expect(await verifyPassword(password, storedHash)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const storedHash = await hashPassword('correct horse 🎾 battery');

    expect(await verifyPassword('correct horse 🎾 batteries', storedHash)).toBe(false);
  });

  it('does not truncate the password after a shared prefix', async () => {
    const firstPassword = `${'🎾'.repeat(40)}-first`;
    const secondPassword = `${'🎾'.repeat(40)}-second`;
    const storedHash = await hashPassword(firstPassword);

    expect(await verifyPassword(firstPassword, storedHash)).toBe(true);
    expect(await verifyPassword(secondPassword, storedHash)).toBe(false);
  });

  it.each(['', 'not-a-password-hash', '$argon2id$v=19$m=1,t=1,p=1$bad$bad'])(
    'returns false for malformed stored hash %j',
    async (storedHash) => {
      await expect(verifyPassword('any password', storedHash)).resolves.toBe(false);
    },
  );
});
