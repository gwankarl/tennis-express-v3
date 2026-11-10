import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import { identityUsers } from '../identity/accounts/user.table.js';
import { sellerApplications, type sellerApplicationCategory } from './application.table.js';
import { sellerApplicationEvidence } from './application-evidence.table.js';
import type {
  CreateSellerApplicationBody,
  SellerApplicationData,
  UpdateSellerApplicationBody,
} from './application.schema.js';

type SellerApplicationDatabase = DatabaseClient['db'];
type ApplicationRow = typeof sellerApplications.$inferSelect;

const openStatuses = ['draft', 'submitted', 'changes_requested'] as const;
const editableStatuses = ['draft', 'changes_requested'] as const;

export interface ApplicationValidationDetail {
  field: string;
  rule: string;
}

export class SellerApplicationServiceError extends Error {
  constructor(
    readonly statusCode: 400 | 403 | 404 | 409,
    readonly field?: string,
    readonly rule?: string,
    readonly details?: readonly ApplicationValidationDetail[],
  ) {
    super('Seller application request failed.');
    this.name = 'SellerApplicationServiceError';
  }
}

function toApplicationData(row: ApplicationRow): SellerApplicationData {
  return {
    id: row.id,
    category: row.category,
    status: row.status,
    revision: row.revision,
    legalName: row.applicantLegalName,
    sellerDisplayName: row.sellerDisplayName,
    areaServed: row.areaServed,
    contactPhone: row.contactPhone,
    registeredBusinessName: row.registeredBusinessName,
    businessRole: row.businessRole,
    storefrontName: row.storefrontName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; cause?: unknown };

  if (candidate.code === '23505') {
    return true;
  }

  return (
    typeof candidate.cause === 'object' &&
    candidate.cause !== null &&
    (candidate.cause as { code?: unknown }).code === '23505'
  );
}

function assertCategoryFields(
  category: (typeof sellerApplicationCategory.enumValues)[number],
  fields: {
    sellerDisplayName?: string | null;
    registeredBusinessName?: string | null;
    businessRole?: string | null;
    storefrontName?: string | null;
  },
): void {
  if (
    category === 'individual' &&
    (fields.registeredBusinessName != null ||
      fields.businessRole != null ||
      fields.storefrontName != null)
  ) {
    throw new SellerApplicationServiceError(400, 'category', 'fields_incompatible_with_category');
  }

  if (category === 'commercial' && fields.sellerDisplayName != null) {
    throw new SellerApplicationServiceError(400, 'category', 'fields_incompatible_with_category');
  }
}

function createValues(body: CreateSellerApplicationBody) {
  return {
    category: body.category,
    applicantLegalName: body.legalName ?? null,
    sellerDisplayName: body.sellerDisplayName ?? null,
    areaServed: body.areaServed ?? null,
    contactPhone: body.contactPhone ?? null,
    registeredBusinessName: body.registeredBusinessName ?? null,
    businessRole: body.businessRole ?? null,
    storefrontName: body.storefrontName ?? null,
  };
}

/** Creates an incomplete Draft, serializing concurrent starts on the user row. */
export async function createSellerApplication(
  db: SellerApplicationDatabase,
  userId: string,
  body: CreateSellerApplicationBody,
): Promise<SellerApplicationData> {
  assertCategoryFields(body.category, body);

  try {
    return await db.transaction(async (tx) => {
      const users = await tx
        .select({
          id: identityUsers.id,
          status: identityUsers.status,
          emailVerifiedAt: identityUsers.emailVerifiedAt,
        })
        .from(identityUsers)
        .where(eq(identityUsers.id, userId))
        .for('update')
        .limit(1);

      const user = users[0];

      if (!user || user.status !== 'active' || user.emailVerifiedAt === null) {
        throw new SellerApplicationServiceError(403);
      }

      const approved = await tx
        .select({ id: sellerApplications.id })
        .from(sellerApplications)
        .where(
          and(eq(sellerApplications.userId, userId), eq(sellerApplications.status, 'approved')),
        )
        .limit(1);

      if (approved.length > 0) {
        throw new SellerApplicationServiceError(409);
      }

      const open = await tx
        .select({ id: sellerApplications.id })
        .from(sellerApplications)
        .where(
          and(
            eq(sellerApplications.userId, userId),
            inArray(sellerApplications.status, [...openStatuses]),
          ),
        )
        .limit(1);

      if (open.length > 0) {
        throw new SellerApplicationServiceError(409);
      }

      const rows = await tx
        .insert(sellerApplications)
        .values({ userId, ...createValues(body) })
        .returning();

      return toApplicationData(rows[0]);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new SellerApplicationServiceError(409);
    }

    throw error;
  }
}

/** Returns the latest application, including a closed outcome, for this user. */
export async function getCurrentSellerApplication(
  db: SellerApplicationDatabase,
  userId: string,
): Promise<SellerApplicationData | null> {
  const rows = await db
    .select()
    .from(sellerApplications)
    .where(eq(sellerApplications.userId, userId))
    .orderBy(desc(sellerApplications.createdAt), desc(sellerApplications.id))
    .limit(1);

  return rows[0] ? toApplicationData(rows[0]) : null;
}

/**
 * Updates only an owned Draft or Changes requested application. The row lock,
 * state check, expected revision, and update share one transaction.
 */
export async function updateSellerApplication(
  db: SellerApplicationDatabase,
  userId: string,
  applicationId: string,
  body: UpdateSellerApplicationBody,
): Promise<SellerApplicationData> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(sellerApplications)
      .where(and(eq(sellerApplications.id, applicationId), eq(sellerApplications.userId, userId)))
      .for('update')
      .limit(1);

    const current = rows[0];

    if (!current) {
      throw new SellerApplicationServiceError(404);
    }

    if (current.revision !== body.expectedRevision) {
      throw new SellerApplicationServiceError(409, 'expectedRevision', 'stale_revision');
    }

    if (!(editableStatuses as readonly string[]).includes(current.status)) {
      throw new SellerApplicationServiceError(409);
    }

    if (body.category !== undefined && current.firstSubmittedAt !== null) {
      throw new SellerApplicationServiceError(409, 'category', 'category_locked');
    }

    const category = body.category ?? current.category;
    assertCategoryFields(category, body);

    const values: Partial<typeof sellerApplications.$inferInsert> = {
      revision: sql`${sellerApplications.revision} + 1` as unknown as number,
      updatedAt: new Date(),
    };

    if (body.category !== undefined) {
      values.category = body.category;

      // Clear fields that belong only to the previous category.
      if (body.category === 'individual') {
        values.registeredBusinessName = null;
        values.businessRole = null;
        values.storefrontName = null;
      } else {
        values.sellerDisplayName = null;
      }
    }

    if (body.legalName !== undefined) values.applicantLegalName = body.legalName;
    if (body.sellerDisplayName !== undefined) values.sellerDisplayName = body.sellerDisplayName;
    if (body.areaServed !== undefined) values.areaServed = body.areaServed;
    if (body.contactPhone !== undefined) values.contactPhone = body.contactPhone;
    if (body.registeredBusinessName !== undefined) {
      values.registeredBusinessName = body.registeredBusinessName;
    }
    if (body.businessRole !== undefined) values.businessRole = body.businessRole;
    if (body.storefrontName !== undefined) values.storefrontName = body.storefrontName;

    const updated = await tx
      .update(sellerApplications)
      .set(values)
      .where(
        and(
          eq(sellerApplications.id, applicationId),
          eq(sellerApplications.userId, userId),
          eq(sellerApplications.revision, body.expectedRevision),
          inArray(sellerApplications.status, [...editableStatuses]),
          ...(body.category === undefined ? [] : [isNull(sellerApplications.firstSubmittedAt)]),
        ),
      )
      .returning();

    if (!updated[0]) {
      throw new SellerApplicationServiceError(409, 'expectedRevision', 'stale_revision');
    }

    return toApplicationData(updated[0]);
  });
}

/**
 * Submits an owned Draft or Changes requested application.
 *
 * The account lock rechecks eligibility at commit time. The application row
 * lock serializes submission against draft edits and evidence replacement.
 * Required evidence is read after acquiring that lock, and the revision is
 * advanced with the status transition in the same transaction.
 */
export async function submitSellerApplication(
  db: SellerApplicationDatabase,
  userId: string,
  applicationId: string,
  expectedRevision: number,
  now = new Date(),
): Promise<SellerApplicationData> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({
        status: identityUsers.status,
        emailVerifiedAt: identityUsers.emailVerifiedAt,
      })
      .from(identityUsers)
      .where(eq(identityUsers.id, userId))
      .for('update')
      .limit(1);

    if (!user || user.status !== 'active' || user.emailVerifiedAt === null) {
      throw new SellerApplicationServiceError(403);
    }

    const [application] = await tx
      .select()
      .from(sellerApplications)
      .where(and(eq(sellerApplications.id, applicationId), eq(sellerApplications.userId, userId)))
      .for('update')
      .limit(1);

    // Foreign and unknown IDs deliberately share the same generic not-found result.
    if (!application) {
      throw new SellerApplicationServiceError(404);
    }

    if (application.revision !== expectedRevision) {
      throw new SellerApplicationServiceError(409, 'expectedRevision', 'stale_revision');
    }

    if (!(editableStatuses as readonly string[]).includes(application.status)) {
      throw new SellerApplicationServiceError(409, 'status', 'application_not_editable');
    }

    const missing: ApplicationValidationDetail[] = [];
    const requiredFields =
      application.category === 'individual'
        ? ([
            ['legalName', application.applicantLegalName],
            ['sellerDisplayName', application.sellerDisplayName],
            ['areaServed', application.areaServed],
          ] as const)
        : ([
            ['legalName', application.applicantLegalName],
            ['registeredBusinessName', application.registeredBusinessName],
            ['businessRole', application.businessRole],
            ['areaServed', application.areaServed],
          ] as const);

    for (const [field, value] of requiredFields) {
      if (value === null || value.trim().length === 0) {
        missing.push({ field, rule: 'required' });
      }
    }

    const evidenceRows = await tx
      .select({ type: sellerApplicationEvidence.type })
      .from(sellerApplicationEvidence)
      .where(eq(sellerApplicationEvidence.applicationId, application.id));

    const uploadedEvidence = new Set(evidenceRows.map((evidence) => evidence.type));
    const requiredEvidence =
      application.category === 'individual'
        ? (['applicant_id'] as const)
        : (['applicant_id', 'business_registration'] as const);

    for (const type of requiredEvidence) {
      if (!uploadedEvidence.has(type)) {
        missing.push({ field: `evidence.${type}`, rule: 'required' });
      }
    }

    if (
      application.category === 'commercial' &&
      application.proofOfAuthorityRequired &&
      !uploadedEvidence.has('proof_of_authority')
    ) {
      missing.push({
        field: 'evidence.proof_of_authority',
        rule: 'required',
      });
    }

    if (missing.length > 0) {
      throw new SellerApplicationServiceError(400, undefined, undefined, missing);
    }

    const submittedAt = new Date(now);
    const [updated] = await tx
      .update(sellerApplications)
      .set({
        status: 'submitted',
        revision: sql`${sellerApplications.revision} + 1`,
        firstSubmittedAt: application.firstSubmittedAt ?? submittedAt,
        proofOfAuthorityRequired: false,
        updatedAt: submittedAt,
      })
      .where(
        and(
          eq(sellerApplications.id, application.id),
          eq(sellerApplications.userId, userId),
          eq(sellerApplications.revision, expectedRevision),
          inArray(sellerApplications.status, [...editableStatuses]),
        ),
      )
      .returning();

    if (!updated) {
      throw new SellerApplicationServiceError(409, 'expectedRevision', 'stale_revision');
    }

    return toApplicationData(updated);
  });
}
