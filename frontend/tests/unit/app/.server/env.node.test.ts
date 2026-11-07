import { describe, expect, it } from 'vitest';
import { FrontendEnvValidationError, parseFrontendEnv } from '../../../../app/.server/env.js';

describe('parseFrontendEnv', () => {
  it('accepts an absolute HTTP URL and positive integer timeout', () => {
    expect(
      parseFrontendEnv({
        BACKEND_API_BASE_URL: 'http://127.0.0.1:3000',
        BACKEND_API_TIMEOUT_MS: '5000',
      }),
    ).toEqual({
      backendApiBaseUrl: 'http://127.0.0.1:3000',
      backendApiTimeoutMs: 5000,
    });
  });

  it.each(['backend.local', 'ftp://backend.local', ''])(
    'rejects malformed backend URL %s',
    (url) => {
      expect(() =>
        parseFrontendEnv({
          BACKEND_API_BASE_URL: url,
          BACKEND_API_TIMEOUT_MS: '5000',
        }),
      ).toThrow(FrontendEnvValidationError);
    },
  );

  it.each(['0', '-1', '1.5', 'abc', ''])('rejects invalid timeout %s', (timeout) => {
    expect(() =>
      parseFrontendEnv({
        BACKEND_API_BASE_URL: 'http://127.0.0.1:3000',
        BACKEND_API_TIMEOUT_MS: timeout,
      }),
    ).toThrow(FrontendEnvValidationError);
  });
});
