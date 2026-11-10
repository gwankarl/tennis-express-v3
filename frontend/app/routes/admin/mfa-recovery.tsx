import type { Route } from './+types/mfa-recovery';
import { Alert } from '~/components/Alert.js';
import { Button } from '~/components/Button.js';
import { FormField } from '~/components/FormField.js';
import { PasswordField } from '~/components/PasswordField.js';
import { AuthCard, AuthPageShell } from '~/features/auth/AuthLayout.js';
import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { loadFrontendConfig } from '~/.server/env.js';
import { appendAdminEnrollmentAuthorizationCookie } from '~/.server/auth/admin-mfa.js';
import {
  RequestProtectionError,
  withProtectedSessionFormRequest,
} from '~/.server/auth/request-protection.js';
import { clearSessionCookie, loadProtectedUser, readSessionToken } from '~/.server/auth/session.js';
import { data, Link, redirect, useFetcher, useLoaderData } from 'react-router';

interface RecoveryResponse {
  status: 'recovered';
  adminHoldUntil: string;
  notificationSent: boolean;
  replacementEnrollmentAuthorization: string;
}

interface CurrentUserResponse {
  id: string;
  email: string;
}

interface RecoveryActionData {
  status: 'recovered' | 'invalid' | 'denied' | 'limited' | 'conflict' | 'unavailable' | 'blocked';
  adminHoldUntil?: string;
  notificationSent?: boolean;
  fieldErrors?: {
    recoveryCode?: string;
    currentPassword?: string;
  };
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const RECOVERY_CODE_PATTERN = /^[A-Fa-f0-9 -]{32,35}$/u;
const ENROLLMENT_AUTHORIZATION_WINDOW_MS = 24 * 60 * 60 * 1000;

function isRecoveryResponse(value: unknown): value is RecoveryResponse {
  return (
    isRecord(value) &&
    value.status === 'recovered' &&
    typeof value.adminHoldUntil === 'string' &&
    Number.isFinite(Date.parse(value.adminHoldUntil)) &&
    typeof value.notificationSent === 'boolean' &&
    typeof value.replacementEnrollmentAuthorization === 'string' &&
    TOKEN_PATTERN.test(value.replacementEnrollmentAuthorization)
  );
}

function isCurrentUserResponse(value: unknown): value is CurrentUserResponse {
  return isRecord(value) && typeof value.id === 'string' && typeof value.email === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function signInRedirect(request: Request, frontendOrigin: string): Response {
  const headers = new Headers();
  clearSessionCookie(request, headers, frontendOrigin);
  return redirect('/login?returnTo=%2Fadmin%2Fmfa%2Frecovery', { headers });
}

export async function loader({ request }: Route.LoaderArgs) {
  const config = loadFrontendConfig();
  const protectedUser = await loadProtectedUser(request, config);
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });

  if (protectedUser.status === 'unavailable') {
    return data({ status: 'unavailable' as const }, { headers });
  }

  if (protectedUser.status === 'restricted') {
    return data({ status: 'restricted' as const }, { headers });
  }

  return data(
    {
      status: 'authenticated' as const,
      csrfToken: protectedUser.csrfToken,
    },
    { headers },
  );
}

export async function action({ request }: Route.ActionArgs) {
  const config = loadFrontendConfig();
  const sessionToken = readSessionToken(request.headers.get('cookie'));

  if (!sessionToken) {
    const headers = new Headers();

    if (request.headers.get('cookie')?.includes('tx_session=')) {
      clearSessionCookie(request, headers, config.frontendOrigin);
    }

    return redirect('/login?returnTo=%2Fadmin%2Fmfa%2Frecovery', { headers });
  }

  let sessionWasConfirmed = false;

  try {
    return await withProtectedSessionFormRequest(request, sessionToken, config, async (form) => {
      const passwordValue = form.get('currentPassword');
      const recoveryCodeValue = form.get('recoveryCode');
      const currentPassword = typeof passwordValue === 'string' ? passwordValue : '';
      const recoveryCode = typeof recoveryCodeValue === 'string' ? recoveryCodeValue.trim() : '';
      const fieldErrors: NonNullable<RecoveryActionData['fieldErrors']> = {};

      if (currentPassword.length === 0 || currentPassword.length > 1024) {
        fieldErrors.currentPassword = 'Enter your current password.';
      }

      if (!RECOVERY_CODE_PATTERN.test(recoveryCode)) {
        fieldErrors.recoveryCode = 'Enter one unused recovery code.';
      }

      if (fieldErrors.currentPassword || fieldErrors.recoveryCode) {
        return data<RecoveryActionData>(
          { status: 'invalid', fieldErrors },
          { status: 400, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }

      const authorizationHeaders = { authorization: `Bearer ${sessionToken}` };

      await requestJson<CurrentUserResponse>('/auth/me', {
        headers: authorizationHeaders,
        signal: request.signal,
        validateData: isCurrentUserResponse,
      });
      sessionWasConfirmed = true;

      const result = await requestJson<RecoveryResponse>('/admin/mfa/recovery', {
        method: 'POST',
        headers: authorizationHeaders,
        body: { currentPassword, recoveryCode },
        signal: request.signal,
        validateData: isRecoveryResponse,
      });

      const holdUntilMs = Date.parse(result.adminHoldUntil);
      const authorizationExpiresAt = new Date(
        holdUntilMs + ENROLLMENT_AUTHORIZATION_WINDOW_MS,
      ).toISOString();
      const responseHeaders = new Headers({ 'Cache-Control': 'private, no-store' });

      // The backend expires this recovery authorization 24 hours after the
      // hold deadline. Keep its raw value only in this HttpOnly cookie.
      appendAdminEnrollmentAuthorizationCookie(
        request,
        responseHeaders,
        result.replacementEnrollmentAuthorization,
        authorizationExpiresAt,
        { frontendOrigin: config.frontendOrigin },
      );
      clearSessionCookie(request, responseHeaders, config.frontendOrigin);

      return data<RecoveryActionData>(
        {
          status: 'recovered',
          adminHoldUntil: result.adminHoldUntil,
          notificationSent: result.notificationSent,
        },
        { headers: responseHeaders },
      );
    });
  } catch (error) {
    if (
      request.signal.aborted ||
      (error instanceof ApiRequestError && error.kind === 'cancelled')
    ) {
      throw error;
    }

    if (error instanceof RequestProtectionError) {
      return data<RecoveryActionData>(
        { status: 'blocked' },
        { status: error.status, headers: { 'Cache-Control': 'private, no-store' } },
      );
    }

    if (error instanceof ApiRequestError && error.kind === 'http') {
      if (error.status === 401 && !sessionWasConfirmed) {
        return signInRedirect(request, config.frontendOrigin);
      }

      if (error.status === 401) {
        return data<RecoveryActionData>(
          {
            status: 'invalid',
            fieldErrors: { currentPassword: 'Check your current password and recovery code.' },
          },
          { status: 401, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }

      if (error.status === 400) {
        return data<RecoveryActionData>(
          {
            status: 'invalid',
            fieldErrors: {
              recoveryCode: 'That recovery code is invalid or has already been used.',
            },
          },
          { status: 400, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }

      if (error.status === 403) {
        return data<RecoveryActionData>(
          { status: 'denied' },
          { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }

      if (error.status === 409) {
        return data<RecoveryActionData>(
          { status: 'conflict' },
          { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }

      if (error.status === 429) {
        return data<RecoveryActionData>(
          { status: 'limited' },
          { status: 429, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }
    }

    return data<RecoveryActionData>(
      { status: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
}

export default function AdminMfaRecoveryPage() {
  const page = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as RecoveryActionData | undefined;
  const isSubmitting = fetcher.state === 'submitting';

  if (page.status === 'unavailable') {
    return (
      <AuthPageShell>
        <AuthCard>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
            Recovery unavailable
          </h1>
          <Alert>The service is temporarily unavailable. Please retry.</Alert>
          <Link className="mt-5 inline-flex font-semibold text-forest underline" to="/account">
            Return to your account
          </Link>
        </AuthCard>
      </AuthPageShell>
    );
  }

  if (page.status === 'restricted') {
    return (
      <AuthPageShell>
        <AuthCard>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
            Administrator recovery unavailable
          </h1>
          <Alert>Administrator recovery is unavailable for this account.</Alert>
          <Link className="mt-5 inline-flex font-semibold text-forest underline" to="/account">
            Return to your account
          </Link>
        </AuthCard>
      </AuthPageShell>
    );
  }

  if (result?.status === 'recovered') {
    const holdDate = new Date(result.adminHoldUntil ?? '').toLocaleString();

    return (
      <AuthPageShell>
        <AuthCard>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
            MFA recovery started
          </h1>
          <p className="mt-3 leading-7 text-muted">
            Your current sessions have been signed out. Sign in again to continue. Administrator
            access is on hold until {holdDate}; after the hold, you can enroll a replacement
            authenticator from this browser.
          </p>
          {result.notificationSent === false && (
            <div className="mt-6">
              <Alert>
                We could not send the security notification. Contact support through your verified
                account channel.
              </Alert>
            </div>
          )}
          <Link
            className="mt-6 inline-flex min-h-12 items-center justify-center rounded-xl bg-forest px-5 py-3 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
            to={`/login?returnTo=${encodeURIComponent('/admin/mfa/enrollment')}`}
          >
            Sign in again
          </Link>
        </AuthCard>
      </AuthPageShell>
    );
  }

  return (
    <AuthPageShell>
      <AuthCard>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
          Recover administrator access
        </h1>
        <p className="mt-3 leading-7 text-muted">
          Use your current password and one unused recovery code. Recovery signs out all of your
          sessions and places administrator access on a 24-hour hold.
        </p>

        {result?.status === 'invalid' && (
          <div className="mt-6">
            <Alert>Check your password and recovery code, then try again.</Alert>
          </div>
        )}
        {result?.status === 'denied' && (
          <div className="mt-6">
            <Alert>Administrator recovery is not available for this account.</Alert>
          </div>
        )}
        {result?.status === 'conflict' && (
          <div className="mt-6">
            <Alert>
              There is no active authenticator to recover. Contact support for assistance.
            </Alert>
          </div>
        )}
        {result?.status === 'limited' && (
          <div className="mt-6">
            <Alert>Too many recovery attempts. Wait 15 minutes before trying again.</Alert>
          </div>
        )}
        {result?.status === 'unavailable' && (
          <div className="mt-6">
            <Alert>Recovery is temporarily unavailable. Please retry.</Alert>
          </div>
        )}
        {result?.status === 'blocked' && (
          <div className="mt-6">
            <Alert>We could not verify this request. Refresh the page and try again.</Alert>
          </div>
        )}

        <fetcher.Form
          action="/admin/mfa/recovery"
          className="mt-8 space-y-6"
          method="post"
          noValidate
          aria-busy={isSubmitting}
        >
          <input name="csrfToken" type="hidden" value={page.csrfToken} />

          <PasswordField
            autoComplete="current-password"
            error={result?.status === 'invalid' ? result.fieldErrors?.currentPassword : undefined}
            id="currentPassword"
            label="Current password"
            name="currentPassword"
            hint="Confirm your account password to continue."
          />

          <FormField
            id="recoveryCode"
            label="Unused recovery code"
            error={result?.status === 'invalid' ? result.fieldErrors?.recoveryCode : undefined}
            hint="Enter one of the ten codes saved when you enrolled your authenticator."
          >
            <input
              aria-invalid={Boolean(
                result?.status === 'invalid' && result.fieldErrors?.recoveryCode,
              )}
              autoComplete="off"
              className="min-h-12 w-full rounded-xl border border-stone-300 bg-white px-4 font-mono text-ink outline-none focus:border-forest focus:ring-2 focus:ring-forest/15"
              id="recoveryCode"
              name="recoveryCode"
              required
              spellCheck={false}
            />
          </FormField>

          <Button disabled={isSubmitting} type="submit">
            {isSubmitting ? 'Recovering access…' : 'Recover administrator access'}
          </Button>
          <p aria-live="polite" className="sr-only" role="status">
            {isSubmitting ? 'Recovering administrator access…' : ''}
          </p>
        </fetcher.Form>

        <p className="mt-6 text-sm text-muted">
          Lost your recovery codes too? Contact support for the operator-assisted recovery process.
        </p>
        <Link className="mt-3 inline-flex font-semibold text-forest underline" to="/account">
          Return to your account
        </Link>
      </AuthCard>
    </AuthPageShell>
  );
}
