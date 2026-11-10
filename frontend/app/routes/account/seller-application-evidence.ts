import type { Route } from './+types/seller-application-evidence';
import { ApiRequestError, requestMultipart } from '~/.server/api-client.js';
import { loadFrontendConfig } from '~/.server/env.js';
import {
  RequestProtectionError,
  withProtectedSessionMultipartRequest,
} from '~/.server/auth/request-protection.js';
import { clearSessionCookie, readSessionToken, safeReturnTo } from '~/.server/auth/session.js';
import { data, redirect } from 'react-router';

const evidenceTypes = ['applicant_id', 'business_registration', 'proof_of_authority'] as const;

type EvidenceType = (typeof evidenceTypes)[number];

interface UploadedEvidence {
  type: EvidenceType;
  mediaType: 'image/jpeg' | 'image/png' | 'application/pdf';
  byteSize: number;
  updatedAt: string;
  revision: number;
}

interface UploadResponse {
  evidence: UploadedEvidence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUploadResponse(value: unknown): value is UploadResponse {
  if (!isRecord(value) || !isRecord(value.evidence)) return false;

  const evidence = value.evidence;

  return (
    (evidence.type === 'applicant_id' ||
      evidence.type === 'business_registration' ||
      evidence.type === 'proof_of_authority') &&
    (evidence.mediaType === 'image/jpeg' ||
      evidence.mediaType === 'image/png' ||
      evidence.mediaType === 'application/pdf') &&
    typeof evidence.byteSize === 'number' &&
    Number.isInteger(evidence.byteSize) &&
    evidence.byteSize >= 1 &&
    evidence.byteSize <= 10 * 1024 * 1024 &&
    typeof evidence.updatedAt === 'string' &&
    Number.isFinite(Date.parse(evidence.updatedAt)) &&
    typeof evidence.revision === 'number' &&
    Number.isInteger(evidence.revision) &&
    evidence.revision >= 1
  );
}

function loginRedirect(request: Request, frontendOrigin: string): Response {
  const headers = new Headers();
  clearSessionCookie(request, headers, frontendOrigin);

  const returnTo = safeReturnTo('/account/seller-application/edit');

  throw redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`, { headers });
}

export async function action({ request }: Route.ActionArgs) {
  const config = loadFrontendConfig();
  const sessionToken = readSessionToken(request.headers.get('cookie'));

  if (!sessionToken) {
    return loginRedirect(request, config.frontendOrigin);
  }

  const url = new URL(request.url);
  const applicationId = url.searchParams.get('applicationId') ?? '';
  const type = url.searchParams.get('type') ?? '';
  const expectedRevision = Number(url.searchParams.get('expectedRevision'));

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      applicationId,
    ) ||
    !evidenceTypes.includes(type as EvidenceType) ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 1
  ) {
    return data({ status: 'invalid' as const, type }, { status: 400 });
  }

  try {
    const result = await withProtectedSessionMultipartRequest(
      request,
      sessionToken,
      config,
      async (form) => {
        const file = form.get('file');

        if (!(file instanceof File) || file.size < 1) {
          return { kind: 'invalid' as const };
        }

        const outgoing = new FormData();
        outgoing.set('file', file, 'evidence');

        const evidence = await requestMultipart<UploadResponse>(
          `/me/seller-applications/${applicationId}/evidence/${type}?expectedRevision=${expectedRevision}`,
          {
            headers: { authorization: `Bearer ${sessionToken}` },
            body: outgoing,
            signal: request.signal,
            validateData: isUploadResponse,
          },
        );

        return { kind: 'uploaded' as const, evidence: evidence.evidence };
      },
    );

    if (result.kind === 'invalid') {
      return data({ status: 'invalid' as const, type }, { status: 400 });
    }

    return data(
      {
        status: 'uploaded' as const,
        type: result.evidence.type,
        revision: result.evidence.revision,
        byteSize: result.evidence.byteSize,
        mediaType: result.evidence.mediaType,
        updatedAt: result.evidence.updatedAt,
      },
      { status: 200 },
    );
  } catch (error) {
    if (
      request.signal.aborted ||
      (error instanceof ApiRequestError && error.kind === 'cancelled')
    ) {
      throw error;
    }

    if (error instanceof RequestProtectionError) {
      if (error.status === 413) {
        return data({ status: 'too-large' as const, type }, { status: 413 });
      }

      return data({ status: 'blocked' as const, type }, { status: error.status });
    }

    if (
      error instanceof ApiRequestError &&
      error.kind === 'http' &&
      error.status === 401 &&
      error.errorCode === 'REQUEST_ERROR'
    ) {
      return loginRedirect(request, config.frontendOrigin);
    }

    if (
      error instanceof ApiRequestError &&
      error.kind === 'http' &&
      error.status === 403 &&
      error.errorCode === 'ACCOUNT_RESTRICTED'
    ) {
      return redirect('/account/seller-application');
    }

    if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 409) {
      return data({ status: 'stale' as const, type }, { status: 409 });
    }

    if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 413) {
      return data({ status: 'too-large' as const, type }, { status: 413 });
    }

    if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 400) {
      return data({ status: 'invalid' as const, type }, { status: 400 });
    }

    return data({ status: 'unavailable' as const, type }, { status: 503 });
  }
}
