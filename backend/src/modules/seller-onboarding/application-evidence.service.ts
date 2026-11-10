import { and, eq, sql } from 'drizzle-orm';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import {
  PrivateEvidenceFileStore,
  type EvidenceMediaType,
  type StagedEvidenceUpload,
} from '../../infrastructure/storage/private-evidence-file-store.js';
import { sellerApplications } from './application.table.js';
import { sellerApplicationEvidence } from './application-evidence.table.js';

export const sellerEvidenceTypes = [
  'applicant_id',
  'business_registration',
  'proof_of_authority',
] as const;

export type SellerEvidenceType = (typeof sellerEvidenceTypes)[number];

export interface UploadedEvidence {
  type: SellerEvidenceType;
  mediaType: EvidenceMediaType;
  byteSize: number;
  updatedAt: string;
  revision: number;
}

export class SellerEvidenceServiceError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    readonly field?: string,
    readonly rule?: string,
  ) {
    super('Seller evidence request failed.');
    this.name = 'SellerEvidenceServiceError';
  }
}

type SellerEvidenceDatabase = DatabaseClient['db'];

function evidenceTypeAllowed(
  category: 'individual' | 'commercial',
  type: SellerEvidenceType,
): boolean {
  return category === 'commercial' || type === 'applicant_id';
}

/**
 * Replaces one evidence file. The application lock serializes replacement and
 * state changes; expectedRevision prevents a stale client from overwriting a
 * newer draft. A promoted but unreferenced object is deleted if the transaction
 * fails. The previously referenced object is deleted only after commit.
 */
export async function replaceSellerEvidence(
  db: SellerEvidenceDatabase,
  store: PrivateEvidenceFileStore,
  input: {
    userId: string;
    applicationId: string;
    type: SellerEvidenceType;
    expectedRevision: number;
    staged: StagedEvidenceUpload;
  },
): Promise<UploadedEvidence> {
  let promoted = false;
  let previousStorageKey: string | undefined;

  try {
    const result = await db.transaction(async (tx) => {
      const [application] = await tx
        .select({
          id: sellerApplications.id,
          category: sellerApplications.category,
          status: sellerApplications.status,
          revision: sellerApplications.revision,
        })
        .from(sellerApplications)
        .where(
          and(
            eq(sellerApplications.id, input.applicationId),
            eq(sellerApplications.userId, input.userId),
          ),
        )
        .for('update')
        .limit(1);

      // Foreign and unknown application IDs intentionally have the same result.
      if (!application) {
        throw new SellerEvidenceServiceError(404);
      }

      if (application.status !== 'draft' && application.status !== 'changes_requested') {
        throw new SellerEvidenceServiceError(409, 'status', 'application_not_editable');
      }

      if (application.revision !== input.expectedRevision) {
        throw new SellerEvidenceServiceError(409, 'expectedRevision', 'stale_revision');
      }

      if (!evidenceTypeAllowed(application.category, input.type)) {
        throw new SellerEvidenceServiceError(400, 'type', 'evidence_type_not_allowed');
      }

      const [existing] = await tx
        .select({ storageKey: sellerApplicationEvidence.storageKey })
        .from(sellerApplicationEvidence)
        .where(
          and(
            eq(sellerApplicationEvidence.applicationId, application.id),
            eq(sellerApplicationEvidence.type, input.type),
          ),
        )
        .limit(1);

      previousStorageKey = existing?.storageKey;

      // Keep the old object intact until the replacement is fully staged.
      await store.promote(input.staged);
      promoted = true;

      const updatedAt = new Date();

      if (existing) {
        await tx
          .update(sellerApplicationEvidence)
          .set({
            storageKey: input.staged.storageKey,
            mediaType: input.staged.mediaType,
            byteSize: input.staged.byteSize,
            sha256: input.staged.sha256,
            updatedAt,
          })
          .where(
            and(
              eq(sellerApplicationEvidence.applicationId, application.id),
              eq(sellerApplicationEvidence.type, input.type),
            ),
          );
      } else {
        await tx.insert(sellerApplicationEvidence).values({
          applicationId: application.id,
          type: input.type,
          storageKey: input.staged.storageKey,
          mediaType: input.staged.mediaType,
          byteSize: input.staged.byteSize,
          sha256: input.staged.sha256,
          updatedAt,
        });
      }

      const [updatedApplication] = await tx
        .update(sellerApplications)
        .set({
          revision: sql`${sellerApplications.revision} + 1`,
          updatedAt,
        })
        .where(
          and(
            eq(sellerApplications.id, application.id),
            eq(sellerApplications.revision, input.expectedRevision),
          ),
        )
        .returning({ revision: sellerApplications.revision });

      if (!updatedApplication) {
        throw new SellerEvidenceServiceError(409, 'expectedRevision', 'stale_revision');
      }

      return {
        type: input.type,
        mediaType: input.staged.mediaType,
        byteSize: input.staged.byteSize,
        updatedAt: updatedAt.toISOString(),
        revision: updatedApplication.revision,
      };
    });

    if (previousStorageKey) {
      await store.deleteStored(previousStorageKey).catch(() => {
        // The scheduled orphan cleanup removes a superseded file if deletion fails.
      });
    }

    return result;
  } catch (error) {
    if (promoted) {
      await store.deleteStored(input.staged.storageKey).catch(() => {
        // The scheduled orphan cleanup removes an unreferenced file if needed.
      });
    } else {
      await store.discardStaged(input.staged).catch(() => undefined);
    }

    throw error;
  }
}

export interface StoredEvidenceForDelivery {
  storageKey: string;
  mediaType: EvidenceMediaType;
  byteSize: number;
}

/** Returns the owner's evidence, using the same not-found result for foreign IDs. */
export async function getOwnedSellerEvidence(
  db: SellerEvidenceDatabase,
  userId: string,
  applicationId: string,
  type: SellerEvidenceType,
): Promise<StoredEvidenceForDelivery> {
  const [row] = await db
    .select({
      storageKey: sellerApplicationEvidence.storageKey,
      mediaType: sellerApplicationEvidence.mediaType,
      byteSize: sellerApplicationEvidence.byteSize,
    })
    .from(sellerApplicationEvidence)
    .innerJoin(
      sellerApplications,
      eq(sellerApplicationEvidence.applicationId, sellerApplications.id),
    )
    .where(
      and(
        eq(sellerApplications.id, applicationId),
        eq(sellerApplications.userId, userId),
        eq(sellerApplicationEvidence.type, type),
      ),
    )
    .limit(1);

  if (!row) {
    throw new SellerEvidenceServiceError(404);
  }

  return row;
}

/**
 * Returns evidence only for another user's submitted application. The route
 * must first run requireWorkspaceAccess('admin'), which rechecks permission
 * and the current session's MFA elevation.
 */
export async function getReviewableSellerEvidence(
  db: SellerEvidenceDatabase,
  reviewerUserId: string,
  applicationId: string,
  type: SellerEvidenceType,
): Promise<StoredEvidenceForDelivery> {
  const [row] = await db
    .select({
      storageKey: sellerApplicationEvidence.storageKey,
      mediaType: sellerApplicationEvidence.mediaType,
      byteSize: sellerApplicationEvidence.byteSize,
    })
    .from(sellerApplicationEvidence)
    .innerJoin(
      sellerApplications,
      eq(sellerApplicationEvidence.applicationId, sellerApplications.id),
    )
    .where(
      and(
        eq(sellerApplications.id, applicationId),
        eq(sellerApplications.status, 'submitted'),
        sql`${sellerApplications.userId} <> ${reviewerUserId}`,
        eq(sellerApplicationEvidence.type, type),
      ),
    )
    .limit(1);

  if (!row) {
    throw new SellerEvidenceServiceError(404);
  }

  return row;
}
