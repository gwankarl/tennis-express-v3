import { and, desc, eq } from 'drizzle-orm';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import type {
  SellerApplicationStatus,
  SellerOperatingAccess,
  SellerWorkspaceFacts,
} from '../../http/guards/authorize-workspace.js';
import { sellerApplications } from './application.table.js';
import { sellerOperatingAccess as sellerOperatingAccessTable } from './review.table.js';

type ApplicationStatus = typeof sellerApplications.$inferSelect.status;

/** Maps lifecycle states to the coarser status exposed for workspace navigation. */
export function mapSellerApplicationStatus(
  status: ApplicationStatus | undefined,
): SellerApplicationStatus {
  if (status === undefined || status === 'draft') {
    return 'not_applied';
  }

  if (status === 'submitted' || status === 'changes_requested') {
    return 'pending';
  }

  return status;
}

/**
 * Reads the latest application and only the operating-access row linked to
 * that account and application. Missing or mismatched access fails closed.
 */
export function createSellerWorkspaceFactsProvider(db: DatabaseClient['db']) {
  return async (userId: string): Promise<SellerWorkspaceFacts> => {
    const [application] = await db
      .select({
        id: sellerApplications.id,
        status: sellerApplications.status,
      })
      .from(sellerApplications)
      .where(eq(sellerApplications.userId, userId))
      .orderBy(desc(sellerApplications.createdAt), desc(sellerApplications.id))
      .limit(1);

    if (!application) {
      return {
        applicationStatus: 'not_applied',
        operatingAccess: 'inactive',
      };
    }

    const [access] = await db
      .select({
        status: sellerOperatingAccessTable.status,
      })
      .from(sellerOperatingAccessTable)
      .where(
        and(
          eq(sellerOperatingAccessTable.userId, userId),
          eq(sellerOperatingAccessTable.applicationId, application.id),
        ),
      )
      .limit(1);

    const operatingAccess: SellerOperatingAccess =
      access?.status === 'active'
        ? 'active'
        : access?.status === 'suspended'
          ? 'suspended'
          : 'inactive';

    return {
      applicationStatus: mapSellerApplicationStatus(application.status),
      operatingAccess,
    };
  };
}
