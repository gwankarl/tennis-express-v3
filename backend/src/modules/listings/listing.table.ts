import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
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
    uniqueIndex('seller_listings_id_seller_id_uq').on(table.id, table.sellerId),
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
 * Catalog presentation captured when a listing revision is submitted.
 * Operational offer values such as price, stock, SKU, and offer state are
 * deliberately excluded.
 */
export interface SellerListingCatalogSnapshot {
  category: {
    id: string;
    slug: string;
    name: string;
    attributeRuleSetKey: string;
    imageUrl: string | null;
  };
  brand: {
    id: string;
    slug: string;
    name: string;
    imageUrl: string | null;
  } | null;
  product: {
    id: string;
    name: string;
    description: string | null;
    fixedAttributes: Record<string, unknown>;
    variantOptionKeys: string[];
  };
  configurations: Array<{
    catalogVariantId: string;
    sellableVariantId: string;
    optionValues: Record<string, unknown>;
    isDefault: boolean;
  }>;
}

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
    submittedByUserId: uuid('submitted_by_user_id').references(() => identityUsers.id, {
      onDelete: 'restrict',
    }),
    catalogSnapshot: jsonb('catalog_snapshot').$type<SellerListingCatalogSnapshot>(),
    title: text('title').notNull(),
    description: text('description'),
    condition: sellerListingCondition('condition').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('seller_listing_revisions_listing_revision_uq').on(table.listingId, table.revision),
    uniqueIndex('seller_listing_revisions_listing_id_uq').on(table.listingId, table.id),
    uniqueIndex('seller_listing_revisions_listing_id_product_uq').on(
      table.listingId,
      table.id,
      table.catalogProductId,
    ),
    check('seller_listing_revisions_revision_positive_ck', sql`${table.revision} > 0`),
    check(
      'seller_listing_revisions_catalog_snapshot_object_ck',
      sql`${table.catalogSnapshot} IS NULL OR jsonb_typeof(${table.catalogSnapshot}) = 'object'`,
    ),
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
    uniqueIndex('seller_listing_revision_configurations_listing_revision_variant_uq').on(
      table.listingId,
      table.revisionId,
      table.catalogVariantId,
    ),
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

/**
 * Stable seller-owned offer for one catalog configuration on a listing.
 * Draft selection changes do not delete these records. Future reservation
 * operations must update reservedQuantity transactionally under a row lock.
 */
export const sellerListingVariants = pgTable(
  'seller_listing_variants',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    listingId: uuid('listing_id').notNull(),
    sellerId: uuid('seller_id').notNull(),
    catalogVariantId: uuid('catalog_variant_id')
      .notNull()
      .references(() => catalogVariants.id, { onDelete: 'restrict' }),
    sku: text('sku').notNull(),
    priceXaf: integer('price_xaf'),
    stockQuantity: integer('stock_quantity').notNull().default(0),
    reservedQuantity: integer('reserved_quantity').notNull().default(0),
    isOfferedForSale: boolean('is_offered_for_sale').notNull().default(false),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'seller_listing_variants_listing_seller_fk',
      columns: [table.listingId, table.sellerId],
      foreignColumns: [sellerListings.id, sellerListings.sellerId],
    }).onDelete('cascade'),
    uniqueIndex('seller_listing_variants_listing_id_uq').on(table.listingId, table.id),
    uniqueIndex('seller_listing_variants_listing_id_variant_catalog_uq').on(
      table.listingId,
      table.id,
      table.catalogVariantId,
    ),
    uniqueIndex('seller_listing_variants_listing_catalog_variant_uq').on(
      table.listingId,
      table.catalogVariantId,
    ),
    uniqueIndex('seller_listing_variants_seller_sku_uq').on(table.sellerId, table.sku),
    index('seller_listing_variants_catalog_variant_idx').on(table.catalogVariantId),
    check(
      'seller_listing_variants_sku_format_ck',
      sql`${table.sku} = upper(btrim(${table.sku}))
        AND ${table.sku} ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'`,
    ),
    check(
      'seller_listing_variants_price_positive_ck',
      sql`${table.priceXaf} IS NULL OR ${table.priceXaf} > 0`,
    ),
    check('seller_listing_variants_stock_nonnegative_ck', sql`${table.stockQuantity} >= 0`),
    check(
      'seller_listing_variants_reserved_range_ck',
      sql`${table.reservedQuantity} >= 0
        AND ${table.reservedQuantity} <= ${table.stockQuantity}`,
    ),
    check(
      'seller_listing_variants_offer_price_ck',
      sql`${table.isOfferedForSale} = false
        OR ${table.priceXaf} IS NOT NULL`,
    ),
    check('seller_listing_variants_version_positive_ck', sql`${table.version} > 0`),
  ],
);

/**
 * Append-only record of seller price changes, including the first price set
 * from an incomplete draft's unset price.
 */
export const sellerListingPriceHistory = pgTable(
  'seller_listing_price_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sellerListingVariantId: uuid('seller_listing_variant_id')
      .notNull()
      .references(() => sellerListingVariants.id, { onDelete: 'cascade' }),
    previousPriceXaf: integer('previous_price_xaf'),
    newPriceXaf: integer('new_price_xaf'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('seller_listing_price_history_variant_changed_idx').on(
      table.sellerListingVariantId,
      table.changedAt,
    ),
    check(
      'seller_listing_price_history_previous_price_ck',
      sql`${table.previousPriceXaf} IS NULL OR ${table.previousPriceXaf} > 0`,
    ),
    check(
      'seller_listing_price_history_new_price_ck',
      sql`${table.newPriceXaf} IS NULL OR ${table.newPriceXaf} > 0`,
    ),
    check(
      'seller_listing_price_history_changed_ck',
      sql`${table.previousPriceXaf} IS DISTINCT FROM ${table.newPriceXaf}`,
    ),
  ],
);

/**
 * Stable seller offer identities selected in one immutable submitted revision.
 * Price, stock, SKU, and offer state remain on sellerListingVariants.
 */
export const sellerListingRevisionOffers = pgTable(
  'seller_listing_revision_offers',
  {
    listingId: uuid('listing_id').notNull(),
    revisionId: uuid('revision_id').notNull(),
    catalogVariantId: uuid('catalog_variant_id').notNull(),
    sellerListingVariantId: uuid('seller_listing_variant_id').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'seller_listing_revision_offers_pk',
      columns: [table.revisionId, table.catalogVariantId],
    }),
    uniqueIndex('seller_listing_revision_offers_revision_offer_uq').on(
      table.revisionId,
      table.sellerListingVariantId,
    ),
    foreignKey({
      name: 'seller_listing_revision_offers_configuration_fk',
      columns: [table.listingId, table.revisionId, table.catalogVariantId],
      foreignColumns: [
        sellerListingRevisionConfigurations.listingId,
        sellerListingRevisionConfigurations.revisionId,
        sellerListingRevisionConfigurations.catalogVariantId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'seller_listing_revision_offers_variant_fk',
      columns: [table.listingId, table.sellerListingVariantId, table.catalogVariantId],
      foreignColumns: [
        sellerListingVariants.listingId,
        sellerListingVariants.id,
        sellerListingVariants.catalogVariantId,
      ],
    }).onDelete('restrict'),
  ],
);

/**
 * Seller-readable review outcome and feedback for an immutable submitted
 * revision. Section 9 will write these records through its review workflow.
 */
export const sellerListingReviewOutcomes = pgTable(
  'seller_listing_review_outcomes',
  {
    revisionId: uuid('revision_id').primaryKey(),
    listingId: uuid('listing_id').notNull(),
    decision: text('decision').notNull(),
    reviewerUserId: uuid('reviewer_user_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'restrict' }),
    feedback: text('feedback'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'seller_listing_review_outcomes_revision_fk',
      columns: [table.listingId, table.revisionId],
      foreignColumns: [sellerListingRevisions.listingId, sellerListingRevisions.id],
    }).onDelete('cascade'),
    index('seller_listing_review_outcomes_listing_reviewed_idx').on(
      table.listingId,
      table.reviewedAt,
    ),
    check(
      'seller_listing_review_outcomes_decision_ck',
      sql`${table.decision} IN ('changes_requested', 'rejected', 'approved')`,
    ),
    check(
      'seller_listing_review_outcomes_feedback_required_ck',
      sql`${table.decision} = 'approved'
        OR (${table.feedback} IS NOT NULL AND btrim(${table.feedback}) <> '')`,
    ),
  ],
);
