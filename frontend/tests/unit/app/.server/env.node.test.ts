import { describe, expect, it } from 'vitest';
import { FrontendEnvValidationError, parseFrontendEnv } from '~/.server/env.js';

const validEnv = {
  BACKEND_API_BASE_URL: 'http://127.0.0.1:3000',
  BACKEND_API_TIMEOUT_MS: '5000',
  FRONTEND_ORIGIN: 'http://127.0.0.1:5173',
  CSRF_SECRET: 'test-only-secret-that-is-at-least-32-bytes-long',
};

describe('parseFrontendEnv', () => {
  it('accepts valid server-only frontend settings', () => {
    expect(parseFrontendEnv(validEnv)).toEqual({
      backendApiBaseUrl: 'http://127.0.0.1:3000',
      backendApiTimeoutMs: 5000,
      frontendOrigin: 'http://127.0.0.1:5173',
      csrfSecret: validEnv.CSRF_SECRET,
    });
  });

  it.each(['backend.local', 'ftp://backend.local', ''])(
    'rejects malformed backend URL %s',
    (url) => {
      expect(() => parseFrontendEnv({ ...validEnv, BACKEND_API_BASE_URL: url })).toThrow(
        FrontendEnvValidationError,
      );
    },
  );

  it.each(['0', '-1', '1.5', 'abc', ''])('rejects invalid backend timeout %s', (timeout) => {
    expect(() => parseFrontendEnv({ ...validEnv, BACKEND_API_TIMEOUT_MS: timeout })).toThrow(
      FrontendEnvValidationError,
    );
  });

  it.each([
    'localhost:5173',
    'ftp://localhost:5173',
    'http://localhost:5173/path',
    'http://user:password@localhost:5173',
    '',
  ])('rejects invalid frontend origin %s', (origin) => {
    expect(() => parseFrontendEnv({ ...validEnv, FRONTEND_ORIGIN: origin })).toThrow(
      FrontendEnvValidationError,
    );
  });

  it.each(['', 'too-short'])('rejects an unsafe CSRF signing secret', (secret) => {
    expect(() => parseFrontendEnv({ ...validEnv, CSRF_SECRET: secret })).toThrow(
      FrontendEnvValidationError,
    );
  });
});
