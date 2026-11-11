import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { identityUsers } from '../identity/accounts/user.table.js';
import { catalogProducts } from '../catalog/product.table.js';
import { catalogVariants } from '../catalog/variant.table.js';

export const sellerListingCondition = pgEnum('seller_listing_condition', [
  'new',
  'like_new',
  'good',
  'fair',
]);

export const sellerListingStatus = pgEnum('seller_listing_status', [
  'draft',
  'submitted',
  'changes_requested',
  'rejected',
  'approved',
]);

/**
 * Seller-owned listing identity and controls. Moderated content lives in the
 * mutable draft and immutable submitted revisions; the approved revision is
 * referenced separately. Controls and administrator removal are independent.
 */
export const sellerListings = pgTable(
  'seller_listings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'cascade' }),
    status: sellerListingStatus('status').notNull().default('draft'),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    administratorRemovedAt: timestamp('administrator_removed_at', { withTimezone: true }),
    controlRevision: integer('control_revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('seller_listings_seller_created_idx').on(table.sellerId, table.createdAt, table.id),
    index('seller_listings_status_updated_idx').on(table.status, table.updatedAt),
    check('seller_listings_control_revision_positive_ck', sql`${table.controlRevision} > 0`),
  ],
);

/**
 * The one editable draft for a listing. It may be incomplete; submission rules
 * and immutable snapshot creation are implemented in a later task.
 */
export const sellerListingDrafts = pgTable(
  'seller_listing_drafts',
  {
    listingId: uuid('listing_id')
      .primaryKey()
      .references(() => sellerListings.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull().default(1),
    catalogProductId: uuid('catalog_product_id')
      .notNull()
      .references(() => catalogProducts.id, { onDelete: 'restrict' }),
    title: text('title'),
    description: text('description'),
    condition: sellerListingCondition('condition'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('seller_listing_drafts_listing_product_uq').on(
      table.listingId,
      table.catalogProductId,
    ),
    check('seller_listing_drafts_revision_positive_ck', sql`${table.revision} > 0`),
    check(
      'seller_listing_drafts_title_ck',
      sql`(
        ${table.title} IS NULL
        OR (
          btrim(${table.title}) <> ''
          AND char_length(${table.title}) <= 120
        )
      )`,
    ),
    check(
      'seller_listing_drafts_description_ck',
      sql`(
        ${table.description} IS NULL
        OR char_length(${table.description}) <= 5000
      )`,
    ),
  ],
);

/**
 * Immutable snapshot shape for a submitted draft. No rows are created until
 * the later submission workflow seals a complete draft.
 */
export const sellerListingRevisions = pgTable(
  'seller_listing_revisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => sellerListings.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    catalogProductId: uuid('catalog_product_id')
      .notNull()
      .references(() => catalogProducts.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    description: text('description'),
    condition: sellerListingCondition('condition').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('seller_listing_revisions_listing_revision_uq').on(table.listingId, table.revision),
    uniqueIndex('seller_listing_revisions_listing_id_product_uq').on(
      table.listingId,
      table.id,
      table.catalogProductId,
    ),
    check('seller_listing_revisions_revision_positive_ck', sql`${table.revision} > 0`),
    check(
      'seller_listing_revisions_title_ck',
      sql`btrim(${table.title}) <> '' AND char_length(${table.title}) <= 120`,
    ),
    check(
      'seller_listing_revisions_description_ck',
      sql`${table.description} IS NULL OR char_length(${table.description}) <= 5000`,
    ),
  ],
);

/**
 * Catalog configurations selected in the current draft. The composite foreign
 * keys ensure each selected configuration belongs to the draft's product and
 * prevent referenced catalog variants from being deleted.
 */
export const sellerListingDraftConfigurations = pgTable(
  'seller_listing_draft_configurations',
  {
    listingId: uuid('listing_id')
      .notNull()
      .references(() => sellerListingDrafts.listingId, { onDelete: 'cascade' }),
    catalogProductId: uuid('catalog_product_id')
      .notNull()
      .references(() => catalogProducts.id, { onDelete: 'restrict' }),
    catalogVariantId: uuid('catalog_variant_id')
      .notNull()
      .references(() => catalogVariants.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({
      name: 'seller_listing_draft_configurations_pk',
      columns: [table.listingId, table.catalogVariantId],
    }),
  ],
);

/**
 * Catalog configurations sealed into a submitted revision. These rows are
 * created with the revision in the later submission workflow.
 */
export const sellerListingRevisionConfigurations = pgTable(
  'seller_listing_revision_configurations',
  {
    listingId: uuid('listing_id')
      .notNull()
      .references(() => sellerListings.id, { onDelete: 'cascade' }),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => sellerListingRevisions.id, { onDelete: 'cascade' }),
    catalogProductId: uuid('catalog_product_id')
      .notNull()
      .references(() => catalogProducts.id, { onDelete: 'restrict' }),
    catalogVariantId: uuid('catalog_variant_id')
      .notNull()
      .references(() => catalogVariants.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({
      name: 'seller_listing_revision_configurations_pk',
      columns: [table.revisionId, table.catalogVariantId],
    }),
  ],
);

/**
 * Points to the listing's currently approved immutable revision. A composite
 * key ensures the approved revision belongs to this listing.
 */
export const sellerListingApprovedRevisions = pgTable(
  'seller_listing_approved_revisions',
  {
    listingId: uuid('listing_id')
      .primaryKey()
      .references(() => sellerListings.id, { onDelete: 'cascade' }),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => sellerListingRevisions.id, { onDelete: 'restrict' }),
  },
  (table) => [uniqueIndex('seller_listing_approved_revisions_revision_uq').on(table.revisionId)],
);
