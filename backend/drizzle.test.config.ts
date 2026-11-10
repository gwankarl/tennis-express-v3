import { defineConfig } from 'drizzle-kit';
import { loadBackendEnv } from './src/config/env.js';
import { requireTestDatabaseUrl } from './tests/helpers/test-database.js';
import { migrationConfig } from './drizzle.config.js';

loadBackendEnv();

const databaseUrl = requireTestDatabaseUrl(process.env);

export default defineConfig({
  ...migrationConfig,
  dbCredentials: {
    url: databaseUrl,
  },
});
