import { defineConfig } from 'drizzle-kit';

export const migrationConfig = {
  dialect: 'postgresql',
  schema: './src/infrastructure/database/schema.ts',
  out: './migrations',
} as const;

export default defineConfig(migrationConfig);
