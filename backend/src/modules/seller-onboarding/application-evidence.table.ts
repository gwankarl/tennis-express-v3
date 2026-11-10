import { sql } from 'drizzle-orm';
import {
  check,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  integer,
} from 'drizzle-orm/pg-core';
import { sellerApplications } from './application.table.js';

export const sellerApplicationEvidenceType = pgEnum('seller_application_evidence_type', [
  'applicant_id',
  'business_registration',
  'proof_of_authority',
]);

export const sellerEvidenceMediaType = pgEnum('seller_evidence_media_type', [
  'image/jpeg',
  'image/png',
  'application/pdf',
]);

/**
 * Stores private evidence metadata. `storageKey` is server-only and must never
 * be included in an API response or log.
 */
export const sellerApplicationEvidence = pgTable(
  'seller_application_evidence',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => sellerApplications.id, { onDelete: 'cascade' }),
    type: sellerApplicationEvidenceType('type').notNull(),
    storageKey: text('storage_key').notNull(),
    mediaType: sellerEvidenceMediaType('media_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('seller_application_evidence_application_type_uq').on(
      table.applicationId,
      table.type,
    ),
    uniqueIndex('seller_application_evidence_storage_key_uq').on(table.storageKey),
    check(
      'seller_application_evidence_storage_key_not_blank_ck',
      sql`btrim(${table.storageKey}) <> ''`,
    ),
    check(
      'seller_application_evidence_byte_size_ck',
      sql`${table.byteSize} BETWEEN 1 AND 10485760`,
    ),
    check('seller_application_evidence_sha256_format_ck', sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);
