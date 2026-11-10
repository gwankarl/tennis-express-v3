import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from '../../../src/config/env.js';

const databaseUrl = 'postgresql://test_user:test_password@127.0.0.1:5432/test_database';

describe('seller evidence storage configuration', () => {
  it('uses the private local directory by default', () => {
    const config = parseEnv({ DATABASE_URL: databaseUrl });

    expect(config.sellerEvidenceStorageDirectory).toBe('C:/tx-private/tennis-xpress/evidence');
  });

  it('accepts an absolute configured directory', () => {
    const config = parseEnv({
      DATABASE_URL: databaseUrl,
      SELLER_EVIDENCE_STORAGE_DIR: 'C:/private/tennis-xpress/evidence',
    });

    expect(config.sellerEvidenceStorageDirectory).toBe('C:/private/tennis-xpress/evidence');
  });

  it('rejects a relative directory and names the invalid setting only', () => {
    try {
      parseEnv({
        DATABASE_URL: databaseUrl,
        SELLER_EVIDENCE_STORAGE_DIR: 'private/evidence',
      });
      throw new Error('Expected environment parsing to reject the relative path.');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).setting).toBe('SELLER_EVIDENCE_STORAGE_DIR');
      expect((error as Error).message).not.toContain('private/evidence');
    }
  });
});
