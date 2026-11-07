import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.node.test.ts', 'tests/integration/**/*.loader.test.tsx'],
    setupFiles: ['tests/helpers/vitest-cleanup.ts'],
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
