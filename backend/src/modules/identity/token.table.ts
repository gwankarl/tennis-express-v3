import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { identityUsers } from './accounts/user.table.js';

export const identityTokenPurpose = pgEnum('identity_token_purpose', [
  'email_verification',
  'password_reset',
]);

export const identityTokens = pgTable(
  'identity_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'cascade' }),
    purpose: identityTokenPurpose('purpose').notNull(),
    tokenDigest: text('token_digest').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('identity_tokens_token_digest_uq').on(table.tokenDigest),
    index('identity_tokens_user_purpose_created_idx').on(
      table.userId,
      table.purpose,
      table.createdAt,
    ),
    index('identity_tokens_expires_idx').on(table.expiresAt),
    check('identity_tokens_token_digest_not_blank_ck', sql`${table.tokenDigest} <> ''`),
  ],
);
