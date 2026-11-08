import { ApiRequestError, requestJson } from '../api-client.js';
import type { FrontendServerConfig } from '../env.js';
import { clearSessionCookie, loadProtectedUser, safeReturnTo } from './session.js';
import { redirect } from 'react-router';

export interface WorkspaceAvailability {
  defaultWorkspace: 'buyer';
  availableWorkspaces: {
    buyer: true;
    seller: boolean;
  };
  sellerApplicationStatus: 'not_applied' | 'pending' | 'approved' | 'rejected' | null;
  adminEntryState: 'unavailable' | 'mfa_required' | 'available';
}

export type WorkspacePageData =
  | {
      status: 'authenticated';
      user: { id: string; email: string };
      csrfToken: string;
      availability: WorkspaceAvailability;
    }
  | { status: 'unavailable' };

/** Validates the unwrapped response data from GET /api/v1/me/workspaces. */
export function isWorkspaceAvailability(value: unknown): value is WorkspaceAvailability {
  if (typeof value !== 'object' || value === null) return false;
  if (
    !('defaultWorkspace' in value) ||
    value.defaultWorkspace !== 'buyer' ||
    !('availableWorkspaces' in value) ||
    typeof value.availableWorkspaces !== 'object' ||
    value.availableWorkspaces === null ||
    !('buyer' in value.availableWorkspaces) ||
    value.availableWorkspaces.buyer !== true ||
    !('seller' in value.availableWorkspaces) ||
    typeof value.availableWorkspaces.seller !== 'boolean' ||
    !('sellerApplicationStatus' in value) ||
    !(
      value.sellerApplicationStatus === null ||
      value.sellerApplicationStatus === 'not_applied' ||
      value.sellerApplicationStatus === 'pending' ||
      value.sellerApplicationStatus === 'approved' ||
      value.sellerApplicationStatus === 'rejected'
    ) ||
    !('adminEntryState' in value) ||
    !(
      value.adminEntryState === 'unavailable' ||
      value.adminEntryState === 'mfa_required' ||
      value.adminEntryState === 'available'
    )
  ) {
    return false;
  }

  return true;
}

/** Loads current account and workspace eligibility for a protected page request. */
export async function loadWorkspacePage(
  request: Request,
  config: FrontendServerConfig,
): Promise<WorkspacePageData> {
  const protectedUser = await loadProtectedUser(request, config);

  if (protectedUser.status === 'unavailable') {
    return { status: 'unavailable' };
  }

  try {
    const availability = await fetchWorkspaceAvailability(
      protectedUser.sessionToken,
      request.signal,
    );

    return {
      status: 'authenticated',
      user: protectedUser.user,
      csrfToken: protectedUser.csrfToken,
      availability,
    };
  } catch (error) {
    if (isCancelled(request, error)) throw error;

    if (isExpiredSession(error)) {
      const headers = new Headers();
      clearSessionCookie(request, headers, config.frontendOrigin);
      const url = new URL(request.url);
      const returnTo = safeReturnTo(`${url.pathname}${url.search}`);
      throw redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`, { headers });
    }

    return { status: 'unavailable' };
  }
}

/** Calls the current availability endpoint with the server-held bearer token. */
export function fetchWorkspaceAvailability(
  sessionToken: string,
  signal: AbortSignal,
): Promise<WorkspaceAvailability> {
  return requestJson<WorkspaceAvailability>('/me/workspaces', {
    headers: { authorization: `Bearer ${sessionToken}` },
    signal,
    validateData: isWorkspaceAvailability,
  });
}

export function isExpiredWorkspaceSession(error: unknown): boolean {
  return isExpiredSession(error);
}

export function isCancelledWorkspaceRequest(request: Request, error: unknown): boolean {
  return isCancelled(request, error);
}

function isExpiredSession(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.kind === 'http' &&
    error.status === 401 &&
    error.errorCode === 'REQUEST_ERROR'
  );
}

function isCancelled(request: Request, error: unknown): boolean {
  return request.signal.aborted || (error instanceof ApiRequestError && error.kind === 'cancelled');
}
