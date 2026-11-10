import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { identityUsers } from '../identity/accounts/user.table.js';

export const sellerApplicationCategory = pgEnum('seller_application_category', [
  'individual',
  'commercial',
]);

export const sellerApplicationStatus = pgEnum('seller_application_status', [
  'draft',
  'submitted',
  'changes_requested',
  'approved',
  'rejected',
]);

export const sellerApplications = pgTable(
  'seller_onboarding_applications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => identityUsers.id, { onDelete: 'cascade' }),
    category: sellerApplicationCategory('category').notNull(),
    status: sellerApplicationStatus('status').notNull().default('draft'),

    // Shared by both categories. Nullable because Drafts may be incomplete.
    applicantLegalName: text('applicant_legal_name'),
    areaServed: text('area_served'),
    contactPhone: text('contact_phone'),

    // Individual-only field.
    sellerDisplayName: text('seller_display_name'),

    // Commercial-only fields.
    registeredBusinessName: text('registered_business_name'),
    businessRole: text('business_role'),
    storefrontName: text('storefront_name'),

    revision: integer('revision').notNull().default(1),
    firstSubmittedAt: timestamp('first_submitted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('seller_onboarding_applications_user_created_idx').on(table.userId, table.createdAt),
    index('seller_onboarding_applications_status_updated_idx').on(table.status, table.updatedAt),

    // Draft, submitted, and changes-requested applications remain open.
    // Approved and rejected applications are closed and do not block reapplication.
    uniqueIndex('seller_onboarding_applications_one_open_per_user_uq')
      .on(table.userId)
      .where(sql`${table.status} IN ('draft', 'submitted', 'changes_requested')`),

    check('seller_onboarding_applications_revision_positive_ck', sql`${table.revision} > 0`),
    check(
      'seller_onboarding_applications_fields_not_blank_ck',
      sql`(
        (${table.applicantLegalName} IS NULL OR btrim(${table.applicantLegalName}) <> '')
        AND (${table.areaServed} IS NULL OR btrim(${table.areaServed}) <> '')
        AND (${table.contactPhone} IS NULL OR btrim(${table.contactPhone}) <> '')
        AND (${table.sellerDisplayName} IS NULL OR btrim(${table.sellerDisplayName}) <> '')
        AND (${table.registeredBusinessName} IS NULL OR btrim(${table.registeredBusinessName}) <> '')
        AND (${table.businessRole} IS NULL OR btrim(${table.businessRole}) <> '')
        AND (${table.storefrontName} IS NULL OR btrim(${table.storefrontName}) <> '')
      )`,
    ),
    check(
      'seller_onboarding_applications_category_fields_ck',
      sql`(
        (${table.category} = 'individual'
          AND ${table.registeredBusinessName} IS NULL
          AND ${table.businessRole} IS NULL
          AND ${table.storefrontName} IS NULL)
        OR
        (${table.category} = 'commercial'
          AND ${table.sellerDisplayName} IS NULL)
      )`,
    ),
    check(
      'seller_onboarding_applications_submission_timestamp_ck',
      sql`(
        (${table.status} = 'draft' AND ${table.firstSubmittedAt} IS NULL)
        OR
        (${table.status} <> 'draft' AND ${table.firstSubmittedAt} IS NOT NULL)
      )`,
    ),
  ],
);
