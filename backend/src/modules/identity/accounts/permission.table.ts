import { pgEnum, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { identityUsers } from './user.table.js';

export const identityPermission = pgEnum('identity_permission', ['administrator']);

export const identityUserPermissions = pgTable(
  'identity_user_permissions',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'cascade' }),
    permission: identityPermission('permission').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.permission],
      name: 'identity_user_permissions_pk',
    }),
  ],
);
