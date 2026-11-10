import { describe, expect, it } from 'vitest';
import { requireTestDatabaseUrl } from '../../helpers/test-database.js';

describe('requireTestDatabaseUrl', () => {
  it('requires TEST_DATABASE_URL explicitly', () => {
    expect(() => requireTestDatabaseUrl({})).toThrow('TEST_DATABASE_URL is required');
  });

  it('accepts the dedicated local test database and matching login', () => {
    const connectionString =
      'postgresql://tennis_xpress_app_test:placeholder@127.0.0.1:5432/tennis_xpress_app_test';

    expect(requireTestDatabaseUrl({ TEST_DATABASE_URL: connectionString })).toBe(connectionString);
  });

  it('rejects a development database target', () => {
    expect(() =>
      requireTestDatabaseUrl({
        TEST_DATABASE_URL:
          'postgres://tennis_xpress_app_test:placeholder@127.0.0.1:5432/tennis_xpress_app_dev',
      }),
    ).toThrow('must target the local tennis_xpress_app_test database');
  });
});
