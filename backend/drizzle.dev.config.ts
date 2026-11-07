import { defineConfig } from 'drizzle-kit';
import { loadBackendEnv } from './src/config/env.js';
import { migrationConfig } from './drizzle.config.js';

loadBackendEnv();

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for development migrations.');
}

export default defineConfig({
  ...migrationConfig,
  dbCredentials: {
    url: databaseUrl,
  },
});
