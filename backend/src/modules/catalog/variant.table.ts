import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { catalogProducts } from './product.table.js';

export const catalogVariants = pgTable(
  'catalog_variants',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    productId: uuid('product_id')
      .notNull()
      .references(() => catalogProducts.id, { onDelete: 'cascade' }),
    optionValues: jsonb('option_values')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // This stores the validator's key-sorted canonical JSON signature.
    optionSignature: text('option_signature').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('catalog_variants_product_idx').on(table.productId),
    uniqueIndex('catalog_variants_product_option_signature_uq').on(
      table.productId,
      table.optionSignature,
    ),
    uniqueIndex('catalog_variants_one_default_per_product_uq')
      .on(table.productId)
      .where(sql`${table.isDefault} = true`),
    check(
      'catalog_variants_option_values_object_ck',
      sql`jsonb_typeof(${table.optionValues}) = 'object'`,
    ),
    check(
      'catalog_variants_option_signature_not_blank_ck',
      sql`btrim(${table.optionSignature}) <> ''`,
    ),
    check(
      'catalog_variants_default_shape_ck',
      sql`${table.isDefault} = false OR (
        ${table.optionValues} = '{}'::jsonb
        AND ${table.optionSignature} = '{}'
      )`,
    ),
  ],
);
