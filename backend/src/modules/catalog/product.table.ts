import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { catalogBrands } from './brand.table.js';
import { catalogCategories } from './category.table.js';

export const catalogProducts = pgTable(
  'catalog_products',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => catalogCategories.id, { onDelete: 'restrict' }),
    // NULL represents the product choice "Unbranded"; it is not a brand row.
    brandId: uuid('brand_id').references(() => catalogBrands.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    fixedAttributes: jsonb('fixed_attributes')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    variantOptionKeys: text('variant_option_keys')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('catalog_products_category_idx').on(table.categoryId),
    index('catalog_products_brand_idx').on(table.brandId),
    check('catalog_products_name_not_blank_ck', sql`btrim(${table.name}) <> ''`),
    check(
      'catalog_products_fixed_attributes_object_ck',
      sql`jsonb_typeof(${table.fixedAttributes}) = 'object'`,
    ),
    check(
      'catalog_products_variant_option_keys_nonblank_ck',
      sql`array_position(${table.variantOptionKeys}, '') IS NULL`,
    ),
  ],
);
