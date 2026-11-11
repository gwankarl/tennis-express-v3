import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { catalogAttributeRuleSetKeys } from './category-attribute-rule-sets.js';

export const catalogAttributeRuleSet = pgEnum(
  'catalog_attribute_rule_set_key',
  catalogAttributeRuleSetKeys,
);

export const catalogCategories = pgTable(
  'catalog_categories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    imageUrl: text('image_url'),
    attributeRuleSetKey: catalogAttributeRuleSet('attribute_rule_set_key').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('catalog_categories_slug_uq').on(table.slug),
    check('catalog_categories_slug_format_ck', sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check('catalog_categories_name_not_blank_ck', sql`btrim(${table.name}) <> ''`),
  ],
);
