import { and, eq, gt, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorResponse } from '../contract.js';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import { identityUserPermissions } from '../../modules/identity/accounts/permission.table.js';
import {
  identityMfaFactors,
  identityMfaRecoveries,
} from '../../modules/identity/admin/admin-security.table.js';
import { identitySessions } from '../../modules/identity/sessions/session.table.js';
import { requireAuthentication } from './authenticate.js';

export type WorkspaceName = 'buyer' | 'seller' | 'admin';

export type SellerApplicationStatus = 'not_applied' | 'pending' | 'approved' | 'rejected';

export type SellerOperatingAccess = 'inactive' | 'active' | 'suspended';

export type AdminEntryState = 'unavailable' | 'mfa_required' | 'available';

export type AdminMfaFactorState = 'none' | 'pending' | 'active' | null;

/**
 * Seller onboarding provides application status and operating access
 * independently. Missing facts fail closed in both navigation and guards.
 */
export interface SellerWorkspaceFacts {
  applicationStatus: SellerApplicationStatus;
  operatingAccess: SellerOperatingAccess;
}

/**
 * Optional authorization sources. App defaults supply database-backed seller
 * facts; omitted facts or MFA elevation still fail closed.
 */
export interface WorkspaceAuthorizationSources {
  getSellerWorkspaceFacts?: (userId: string) => Promise<SellerWorkspaceFacts | undefined>;
  isSessionMfaElevated?: (sessionId: string) => Promise<boolean>;
}

export interface WorkspaceAvailabilityDecision {
  sellerAvailable: boolean;
  sellerApplicationStatus: SellerApplicationStatus | null;
  adminEntryState: AdminEntryState;
  adminMfaFactorState: AdminMfaFactorState;
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

/** Seller access requires an approved application and active operating access. */
export function isSellerWorkspaceAvailable(facts: SellerWorkspaceFacts | undefined): boolean {
  return facts?.applicationStatus === 'approved' && facts.operatingAccess === 'active';
}

async function getSellerDecision(
  userId: string,
  sources: WorkspaceAuthorizationSources,
): Promise<{ available: boolean; applicationStatus: SellerApplicationStatus | null }> {
  const facts = await sources.getSellerWorkspaceFacts?.(userId);

  return {
    available: isSellerWorkspaceAvailable(facts),
    applicationStatus: facts?.applicationStatus ?? null,
  };
}

interface AdminEntryDecision {
  entryState: AdminEntryState;
  factorState: AdminMfaFactorState;
}

async function getAdminEntryDecision(
  db: DatabaseClient['db'],
  userId: string,
  sessionId: string,
  sources: WorkspaceAuthorizationSources,
): Promise<AdminEntryDecision> {
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
    return { entryState: 'unavailable', factorState: null };
  }

  const factors = await db
    .select({ status: identityMfaFactors.status })
    .from(identityMfaFactors)
    .where(
      and(
        eq(identityMfaFactors.userId, userId),
        inArray(identityMfaFactors.status, ['pending', 'active']),
      ),
    )
    .limit(1);

  const storedFactorStatus = factors[0]?.status;
  const factorState: AdminMfaFactorState =
    storedFactorStatus === 'active'
      ? 'active'
      : storedFactorStatus === 'pending'
        ? 'pending'
        : 'none';

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
    return { entryState: 'mfa_required', factorState };
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

  return {
    entryState: mfaElevated ? 'available' : 'mfa_required',
    factorState,
  };
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
  const [seller, admin] = await Promise.all([
    getSellerDecision(userId, sources),
    getAdminEntryDecision(db, userId, sessionId, sources),
  ]);

  return {
    sellerAvailable: seller.available,
    sellerApplicationStatus: seller.applicationStatus,
    adminEntryState: admin.entryState,
    adminMfaFactorState: admin.factorState,
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

      const authorizationSources: WorkspaceAuthorizationSources = {
        ...request.server.workspaceAuthorizationSources,
        ...sources,
      };

      if (workspace === 'buyer') {
        return;
      }

      if (workspace === 'seller') {
        const seller = await getSellerDecision(session.userId, authorizationSources);

        if (!seller.available) {
          sendWorkspaceError(request, reply, 403);
        }

        return;
      }

      const db = request.server.db;

      if (!db) {
        throw new Error('Workspace authorization database is unavailable.');
      }

      const admin = await getAdminEntryDecision(
        db,
        session.userId,
        session.sessionId,
        authorizationSources,
      );

      if (admin.entryState !== 'available') {
        sendWorkspaceError(request, reply, 403);
      }
    },
  ];
}
