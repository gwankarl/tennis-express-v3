import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { identityUsers } from '../accounts/user.table.js';

export const identitySessions = pgTable(
  'identity_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'cascade' }),
    tokenDigest: text('token_digest').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    adminMfaElevatedAt: timestamp('admin_mfa_elevated_at', { withTimezone: true }),
    adminMfaElevatedUntil: timestamp('admin_mfa_elevated_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('identity_sessions_token_digest_uq').on(table.tokenDigest),
    index('identity_sessions_user_revoked_idx').on(table.userId, table.revokedAt),
    index('identity_sessions_idle_expires_idx').on(table.idleExpiresAt),
    index('identity_sessions_absolute_expires_idx').on(table.absoluteExpiresAt),
    check('identity_sessions_token_digest_not_blank_ck', sql`${table.tokenDigest} <> ''`),
    check(
      'identity_sessions_idle_before_absolute_ck',
      sql`${table.idleExpiresAt} <= ${table.absoluteExpiresAt}`,
    ),
    index('identity_sessions_user_admin_mfa_until_idx').on(
      table.userId,
      table.adminMfaElevatedUntil,
    ),
    check(
      'identity_sessions_admin_mfa_elevation_ck',
      sql`(
        (${table.adminMfaElevatedAt} IS NULL
          AND ${table.adminMfaElevatedUntil} IS NULL)
        OR
        (${table.adminMfaElevatedAt} IS NOT NULL
          AND ${table.adminMfaElevatedUntil} IS NOT NULL
          AND ${table.adminMfaElevatedUntil} > ${table.adminMfaElevatedAt}
          AND ${table.adminMfaElevatedUntil} <= ${table.absoluteExpiresAt})
      )`,
    ),
  ],
);
