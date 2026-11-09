import { and, eq, gt, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorResponse } from '../contract.js';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import { identityUserPermissions } from '../../modules/identity/accounts/permission.table.js';
import { identityMfaRecoveries } from '../../modules/identity/admin/admin-security.table.js';
import { identitySessions } from '../../modules/identity/sessions/session.table.js';
import { requireAuthentication } from './authenticate.js';

export type WorkspaceName = 'buyer' | 'seller' | 'admin';

export type SellerApplicationStatus = 'not_applied' | 'pending' | 'approved' | 'rejected';

export type SellerOperatingAccess = 'inactive' | 'active' | 'suspended';

export type AdminEntryState = 'unavailable' | 'mfa_required' | 'available';

/**
 * Seller onboarding must eventually provide application status and operating
 * access independently. No production provider is configured yet.
 */
export interface SellerWorkspaceFacts {
  applicationStatus: SellerApplicationStatus;
  operatingAccess: SellerOperatingAccess;
}

/**
 * Optional future evidence sources. Omitted seller or MFA evidence fails closed.
 */
export interface WorkspaceAuthorizationSources {
  getSellerWorkspaceFacts?: (userId: string) => Promise<SellerWorkspaceFacts | undefined>;
  isSessionMfaElevated?: (sessionId: string) => Promise<boolean>;
}

export interface WorkspaceAvailabilityDecision {
  sellerAvailable: boolean;
  sellerApplicationStatus: SellerApplicationStatus | null;
  adminEntryState: AdminEntryState;
}

function sendWorkspaceError(request: FastifyRequest, reply: FastifyReply, status: 401 | 403): void {
  const body: ApiErrorResponse = {
    error: {
      code: 'REQUEST_ERROR',
      message: 'Request failed',
    },
    requestId: request.id,
  };

  reply.code(status).send(body);
}

async function getSellerDecision(
  userId: string,
  sources: WorkspaceAuthorizationSources,
): Promise<{ available: boolean; applicationStatus: SellerApplicationStatus | null }> {
  const facts = await sources.getSellerWorkspaceFacts?.(userId);

  return {
    available: facts?.applicationStatus === 'approved' && facts.operatingAccess === 'active',
    applicationStatus: facts?.applicationStatus ?? null,
  };
}

async function getAdminEntryState(
  db: DatabaseClient['db'],
  userId: string,
  sessionId: string,
  sources: WorkspaceAuthorizationSources,
): Promise<AdminEntryState> {
  const grants = await db
    .select({ userId: identityUserPermissions.userId })
    .from(identityUserPermissions)
    .where(
      and(
        eq(identityUserPermissions.userId, userId),
        eq(identityUserPermissions.permission, 'administrator'),
      ),
    )
    .limit(1);

  if (grants.length === 0) {
    return 'unavailable';
  }

  const activeRecoveryHolds = await db
    .select({ id: identityMfaRecoveries.id })
    .from(identityMfaRecoveries)
    .where(
      and(
        eq(identityMfaRecoveries.userId, userId),
        eq(identityMfaRecoveries.status, 'completed'),
        gt(identityMfaRecoveries.adminHoldUntil, sql`clock_timestamp()`),
      ),
    )
    .limit(1);

  if (activeRecoveryHolds.length > 0) {
    return 'mfa_required';
  }

  const mfaElevated = sources.isSessionMfaElevated
    ? await sources.isSessionMfaElevated(sessionId)
    : (
        await db
          .select({ sessionId: identitySessions.id })
          .from(identitySessions)
          .where(
            and(
              eq(identitySessions.id, sessionId),
              eq(identitySessions.userId, userId),
              isNull(identitySessions.revokedAt),
              isNotNull(identitySessions.adminMfaElevatedAt),
              lte(identitySessions.adminMfaElevatedAt, sql`clock_timestamp()`),
              gt(identitySessions.adminMfaElevatedUntil, sql`clock_timestamp()`),
              gt(identitySessions.idleExpiresAt, sql`clock_timestamp()`),
              gt(identitySessions.absoluteExpiresAt, sql`clock_timestamp()`),
            ),
          )
          .limit(1)
      ).length === 1;

  return mfaElevated ? 'available' : 'mfa_required';
}

/**
 * Resolves current navigation availability after the caller has authenticated
 * the session and revalidated active, verified account eligibility.
 */
export async function resolveWorkspaceAvailability(
  db: DatabaseClient['db'],
  userId: string,
  sessionId: string,
  sources: WorkspaceAuthorizationSources = {},
): Promise<WorkspaceAvailabilityDecision> {
  const [seller, adminEntryState] = await Promise.all([
    getSellerDecision(userId, sources),
    getAdminEntryState(db, userId, sessionId, sources),
  ]);

  return {
    sellerAvailable: seller.available,
    sellerApplicationStatus: seller.applicationStatus,
    adminEntryState,
  };
}

/**
 * Composes the current-session guard with an independent workspace check.
 * Buyer is the default for active, verified sessions.
 */
export function requireWorkspaceAccess(
  workspace: WorkspaceName,
  sources: WorkspaceAuthorizationSources = {},
) {
  return [
    requireAuthentication,
    async function authorizeWorkspace(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      const session = request.identitySession;

      if (!session) {
        sendWorkspaceError(request, reply, 401);
        return;
      }

      if (workspace === 'buyer') {
        return;
      }

      if (workspace === 'seller') {
        const seller = await getSellerDecision(session.userId, sources);

        if (!seller.available) {
          sendWorkspaceError(request, reply, 403);
        }

        return;
      }

      const db = request.server.db;

      if (!db) {
        throw new Error('Workspace authorization database is unavailable.');
      }

      const adminEntryState = await getAdminEntryState(
        db,
        session.userId,
        session.sessionId,
        sources,
      );

      if (adminEntryState !== 'available') {
        sendWorkspaceError(request, reply, 403);
      }
    },
  ];
}
