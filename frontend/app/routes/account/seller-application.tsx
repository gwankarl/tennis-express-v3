import type { Route } from './+types/seller-application';
import { Alert } from '~/components/Alert.js';
import { AuthCard, AuthPageShell } from '~/features/auth/AuthLayout.js';
import {
  RestrictedAccountState,
  TemporaryAccessState,
} from '~/features/auth/AccountAccessStates.js';
import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { loadFrontendConfig } from '~/.server/env.js';
import { clearSessionCookie, loadProtectedUser, safeReturnTo } from '~/.server/auth/session.js';
import { Link, redirect, useLoaderData } from 'react-router';

type EvidenceType = 'applicant_id' | 'business_registration' | 'proof_of_authority';
type EvidenceMediaType = 'image/jpeg' | 'image/png' | 'application/pdf';
type ApplicationStatus = 'draft' | 'submitted' | 'changes_requested' | 'approved' | 'rejected';

interface SellerApplication {
  id: string;
  category: 'individual' | 'commercial';
  status: ApplicationStatus;
  revision: number;
  legalName: string | null;
  sellerDisplayName: string | null;
  areaServed: string | null;
  contactPhone: string | null;
  registeredBusinessName: string | null;
  businessRole: string | null;
  storefrontName: string | null;
  proofOfAuthorityRequired: boolean;
  evidence: Array<{
    type: EvidenceType;
    mediaType: EvidenceMediaType;
    byteSize: number;
    updatedAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

interface CurrentApplicationResponse {
  application: SellerApplication | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDateTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isEvidence(value: unknown): value is SellerApplication['evidence'][number] {
  if (!isRecord(value)) return false;

  return (
    (value.type === 'applicant_id' ||
      value.type === 'business_registration' ||
      value.type === 'proof_of_authority') &&
    (value.mediaType === 'image/jpeg' ||
      value.mediaType === 'image/png' ||
      value.mediaType === 'application/pdf') &&
    typeof value.byteSize === 'number' &&
    Number.isInteger(value.byteSize) &&
    value.byteSize >= 1 &&
    value.byteSize <= 10 * 1024 * 1024 &&
    isDateTime(value.updatedAt)
  );
}

function isSellerApplication(value: unknown): value is SellerApplication {
  if (!isRecord(value)) return false;

  const nullableFields = [
    'legalName',
    'sellerDisplayName',
    'areaServed',
    'contactPhone',
    'registeredBusinessName',
    'businessRole',
    'storefrontName',
  ] as const;

  return (
    typeof value.id === 'string' &&
    (value.category === 'individual' || value.category === 'commercial') &&
    (value.status === 'draft' ||
      value.status === 'submitted' ||
      value.status === 'changes_requested' ||
      value.status === 'approved' ||
      value.status === 'rejected') &&
    typeof value.revision === 'number' &&
    Number.isInteger(value.revision) &&
    value.revision >= 1 &&
    nullableFields.every((field) => value[field] === null || typeof value[field] === 'string') &&
    typeof value.proofOfAuthorityRequired === 'boolean' &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isEvidence) &&
    isDateTime(value.createdAt) &&
    isDateTime(value.updatedAt)
  );
}

function isCurrentApplicationResponse(value: unknown): value is CurrentApplicationResponse {
  return (
    isRecord(value) &&
    'application' in value &&
    (value.application === null || isSellerApplication(value.application))
  );
}

function isCancelled(request: Request, error: unknown): boolean {
  return request.signal.aborted || (error instanceof ApiRequestError && error.kind === 'cancelled');
}

function isExpiredSession(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.kind === 'http' &&
    error.status === 401 &&
    error.errorCode === 'REQUEST_ERROR'
  );
}

function isRestrictedAccount(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.kind === 'http' &&
    error.status === 403 &&
    error.errorCode === 'ACCOUNT_RESTRICTED'
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  const config = loadFrontendConfig();
  const protectedUser = await loadProtectedUser(request, config);

  if (protectedUser.status === 'unavailable') {
    return { status: 'unavailable' as const };
  }

  if (protectedUser.status === 'restricted') {
    return { status: 'restricted' as const, csrfToken: protectedUser.csrfToken };
  }

  try {
    const current = await requestJson<CurrentApplicationResponse>(
      '/me/seller-applications/current',
      {
        headers: { authorization: `Bearer ${protectedUser.sessionToken}` },
        signal: request.signal,
        validateData: isCurrentApplicationResponse,
      },
    );

    return {
      status: 'loaded' as const,
      application: current.application,
    };
  } catch (error) {
    if (isCancelled(request, error)) throw error;

    if (isRestrictedAccount(error)) {
      return { status: 'restricted' as const, csrfToken: protectedUser.csrfToken };
    }

    if (isExpiredSession(error)) {
      const headers = new Headers();
      clearSessionCookie(request, headers, config.frontendOrigin);

      const url = new URL(request.url);
      const returnTo = safeReturnTo(`${url.pathname}${url.search}`);

      throw redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`, { headers });
    }

    return { status: 'unavailable' as const };
  }
}

function ApplicationActionLink({ to, children }: { to: string; children: string }) {
  return (
    <Link
      className="mt-6 inline-flex rounded-md bg-forest px-5 py-3 font-semibold text-white hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
      to={to}
    >
      {children}
    </Link>
  );
}

export default function SellerApplicationPage() {
  const page = useLoaderData<typeof loader>();

  if (page.status === 'restricted') {
    return <RestrictedAccountState csrfToken={page.csrfToken} />;
  }

  if (page.status === 'unavailable') {
    return (
      <TemporaryAccessState
        title="Seller application temporarily unavailable"
        message="We couldn’t check your application. Your session is still in place; try again."
      />
    );
  }

  const application = page.application;

  return (
    <AuthPageShell>
      <AuthCard>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">Seller application</h1>

        {!application && (
          <>
            <p className="mt-3 leading-7 text-muted">
              Start an application to sell Tennis Xpress equipment.
            </p>
            <ApplicationActionLink to="/account/seller-application/edit">
              Start application
            </ApplicationActionLink>
          </>
        )}

        {application?.status === 'draft' && (
          <>
            <p className="mt-3 leading-7 text-muted">
              Your {application.category} application is a draft.
            </p>
            <ApplicationActionLink to="/account/seller-application/edit">
              Resume draft
            </ApplicationActionLink>
          </>
        )}

        {application?.status === 'changes_requested' && (
          <>
            <p className="mt-3 leading-7 text-muted">
              Changes were requested for your {application.category} application.
            </p>
            {application.proofOfAuthorityRequired && (
              <Alert>The reviewer requested proof of authority for your business.</Alert>
            )}
            <ApplicationActionLink to="/account/seller-application/edit">
              Revise application
            </ApplicationActionLink>
          </>
        )}

        {application?.status === 'submitted' && (
          <>
            <p className="mt-3 leading-7 text-muted">
              Your {application.category} application has been submitted.
            </p>
            <p className="mt-2 text-sm text-muted">
              Status: <span className="font-semibold text-ink">Submitted</span>
            </p>
          </>
        )}

        {application?.status === 'approved' && (
          <>
            <p className="mt-3 leading-7 text-muted">
              Your {application.category} seller application was approved.
            </p>
          </>
        )}

        {application?.status === 'rejected' && (
          <>
            <p className="mt-3 leading-7 text-muted">
              Your {application.category} seller application was rejected.
            </p>
            <ApplicationActionLink to="/account/seller-application/edit?new=1">
              Start a new application
            </ApplicationActionLink>
          </>
        )}

        {application && (
          <p className="mt-6 text-sm text-muted">Application revision {application.revision}</p>
        )}

        <Link className="mt-6 inline-flex font-semibold text-forest underline" to="/account">
          Back to Account
        </Link>
      </AuthCard>
    </AuthPageShell>
  );
}
