import { defineConfig } from 'vitest/config';
import { loadBackendEnv } from './src/config/env.js';

loadBackendEnv();

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
