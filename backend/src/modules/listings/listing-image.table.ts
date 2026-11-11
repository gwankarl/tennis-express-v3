import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  sellerListingDrafts,
  sellerListingRevisions,
  sellerListingVariants,
  sellerListings,
} from './listing.table.js';

export const sellerListingImageMediaType = pgEnum('seller_listing_image_media_type', [
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export const sellerListingImageLifecycle = pgEnum('seller_listing_image_lifecycle', [
  'ready',
  'deleting',
]);

/**
 * Immutable, private image object metadata. Storage keys are generated UUIDs;
 * file contents are stored separately and never replaced in place.
 */
export const sellerListingImages = pgTable(
  'seller_listing_images',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => sellerListings.id, { onDelete: 'cascade' }),
    storageKey: uuid('storage_key').notNull(),
    mediaType: sellerListingImageMediaType('media_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    sha256: text('sha256').notNull(),
    lifecycle: sellerListingImageLifecycle('lifecycle').notNull().default('ready'),
    unreferencedAt: timestamp('unreferenced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('seller_listing_images_storage_key_uq').on(table.storageKey),
    uniqueIndex('seller_listing_images_listing_id_id_uq').on(table.listingId, table.id),
    index('seller_listing_images_cleanup_idx').on(
      table.lifecycle,
      table.unreferencedAt,
      table.createdAt,
    ),
    check('seller_listing_images_size_ck', sql`${table.byteSize} BETWEEN 1 AND 8388608`),
    check(
      'seller_listing_images_dimensions_ck',
      sql`${table.width} >= 320
        AND ${table.height} >= 320
        AND ${table.width} <= 8000
        AND ${table.height} <= 8000
        AND ${table.width}::bigint * ${table.height}::bigint <= 40000000`,
    ),
    check('seller_listing_images_sha256_ck', sql`${table.sha256} ~ '^[a-f0-9]{64}$'`),
    check(
      'seller_listing_images_cleanup_state_ck',
      sql`${table.lifecycle} = 'ready'
        OR ${table.unreferencedAt} IS NOT NULL`,
    ),
  ],
);

/**
 * Current draft image selection. A null variantId means the image is common to
 * the listing; otherwise it is assigned to that stable sellable variant.
 * The same image may have assignments for multiple variants.
 */
export const sellerListingDraftImages = pgTable(
  'seller_listing_draft_images',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    listingId: uuid('listing_id').notNull(),
    imageId: uuid('image_id').notNull(),
    variantId: uuid('variant_id'),
    sortOrder: integer('sort_order').notNull(),
    isCover: boolean('is_cover').notNull().default(false),
  },
  (table) => [
    foreignKey({
      name: 'seller_listing_draft_images_listing_fk',
      columns: [table.listingId],
      foreignColumns: [sellerListingDrafts.listingId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'seller_listing_draft_images_image_fk',
      columns: [table.listingId, table.imageId],
      foreignColumns: [sellerListingImages.listingId, sellerListingImages.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'seller_listing_draft_images_variant_fk',
      columns: [table.listingId, table.variantId],
      foreignColumns: [sellerListingVariants.listingId, sellerListingVariants.id],
    }).onDelete('restrict'),
    uniqueIndex('seller_listing_draft_images_common_image_uq')
      .on(table.listingId, table.imageId)
      .where(sql`${table.variantId} IS NULL`),
    uniqueIndex('seller_listing_draft_images_variant_image_uq')
      .on(table.listingId, table.imageId, table.variantId)
      .where(sql`${table.variantId} IS NOT NULL`),
    uniqueIndex('seller_listing_draft_images_common_order_uq')
      .on(table.listingId, table.sortOrder)
      .where(sql`${table.variantId} IS NULL`),
    uniqueIndex('seller_listing_draft_images_variant_order_uq')
      .on(table.listingId, table.variantId, table.sortOrder)
      .where(sql`${table.variantId} IS NOT NULL`),
    uniqueIndex('seller_listing_draft_images_common_cover_uq')
      .on(table.listingId)
      .where(sql`${table.variantId} IS NULL AND ${table.isCover} = true`),
    uniqueIndex('seller_listing_draft_images_variant_cover_uq')
      .on(table.listingId, table.variantId)
      .where(sql`${table.variantId} IS NOT NULL AND ${table.isCover} = true`),
    index('seller_listing_draft_images_image_idx').on(table.imageId),
    check('seller_listing_draft_images_order_ck', sql`${table.sortOrder} >= 0`),
  ],
);

/**
 * Immutable image selection sealed into a submitted listing revision.
 * Composite foreign keys prevent cross-listing image or variant assignments.
 */
export const sellerListingRevisionImages = pgTable(
  'seller_listing_revision_images',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    listingId: uuid('listing_id').notNull(),
    revisionId: uuid('revision_id').notNull(),
    imageId: uuid('image_id').notNull(),
    variantId: uuid('variant_id'),
    sortOrder: integer('sort_order').notNull(),
    isCover: boolean('is_cover').notNull().default(false),
  },
  (table) => [
    foreignKey({
      name: 'seller_listing_revision_images_revision_fk',
      columns: [table.listingId, table.revisionId],
      foreignColumns: [sellerListingRevisions.listingId, sellerListingRevisions.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'seller_listing_revision_images_image_fk',
      columns: [table.listingId, table.imageId],
      foreignColumns: [sellerListingImages.listingId, sellerListingImages.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'seller_listing_revision_images_variant_fk',
      columns: [table.listingId, table.variantId],
      foreignColumns: [sellerListingVariants.listingId, sellerListingVariants.id],
    }).onDelete('restrict'),
    uniqueIndex('seller_listing_revision_images_common_image_uq')
      .on(table.revisionId, table.imageId)
      .where(sql`${table.variantId} IS NULL`),
    uniqueIndex('seller_listing_revision_images_variant_image_uq')
      .on(table.revisionId, table.imageId, table.variantId)
      .where(sql`${table.variantId} IS NOT NULL`),
    uniqueIndex('seller_listing_revision_images_common_order_uq')
      .on(table.revisionId, table.sortOrder)
      .where(sql`${table.variantId} IS NULL`),
    uniqueIndex('seller_listing_revision_images_variant_order_uq')
      .on(table.revisionId, table.variantId, table.sortOrder)
      .where(sql`${table.variantId} IS NOT NULL`),
    uniqueIndex('seller_listing_revision_images_common_cover_uq')
      .on(table.revisionId)
      .where(sql`${table.variantId} IS NULL AND ${table.isCover} = true`),
    uniqueIndex('seller_listing_revision_images_variant_cover_uq')
      .on(table.revisionId, table.variantId)
      .where(sql`${table.variantId} IS NOT NULL AND ${table.isCover} = true`),
    index('seller_listing_revision_images_image_idx').on(table.imageId),
    check('seller_listing_revision_images_order_ck', sql`${table.sortOrder} >= 0`),
  ],
);
