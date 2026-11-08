import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const identityUsers = pgTable(
  'identity_users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    deliveryEmail: text('delivery_email').notNull(),
    normalizedEmail: text('normalized_email').notNull(),
    displayName: text('display_name'),
    status: text('status').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('identity_users_normalized_email_uq').on(table.normalizedEmail),
    index('identity_users_status_idx').on(table.status),
    check(
      'identity_users_emails_not_blank_ck',
      sql`${table.deliveryEmail} <> '' AND ${table.normalizedEmail} <> ''`,
    ),
    check(
      'identity_users_normalized_email_lowercase_ck',
      sql`${table.normalizedEmail} = lower(btrim(${table.normalizedEmail}))`,
    ),
  ],
);
