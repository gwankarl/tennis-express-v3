import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { identityUsers } from '../accounts/user.table.js';

export const identityCredentials = pgTable('identity_credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => identityUsers.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
