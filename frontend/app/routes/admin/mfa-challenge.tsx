import type { Route } from './+types/mfa-challenge';
import { Alert } from '~/components/Alert.js';
import { Button } from '~/components/Button.js';
import { FormField } from '~/components/FormField.js';
import { PasswordField } from '~/components/PasswordField.js';
import { AuthCard, AuthPageShell } from '~/features/auth/AuthLayout.js';
import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { loadFrontendConfig } from '~/.server/env.js';
import {
  appendAdminMfaChallengeCookie,
  clearAdminMfaChallengeCookie,
  readAdminMfaChallenge,
} from '~/.server/auth/admin-mfa.js';
import {
  RequestProtectionError,
  withProtectedSessionFormRequest,
} from '~/.server/auth/request-protection.js';
import {
  appendSessionCookie,
  clearSessionCookie,
  loadProtectedUser,
  readSessionToken,
  safeReturnTo,
} from '~/.server/auth/session.js';
import { data, Link, redirect, useFetcher, useLoaderData } from 'react-router';

interface StartChallengeResponse {
  challenge: string;
  expiresAt: string;
}

interface ConfirmChallengeResponse {
  sessionToken: string;
  tokenType: 'Bearer';
  expiresAt: string;
  elevatedUntil: string;
}

interface CurrentUserResponse {
  id: string;
  email: string;
}

interface ChallengeActionData {
  status: 'challenge' | 'invalid' | 'denied' | 'limited' | 'unavailable' | 'blocked';
  step?: 'start' | 'confirm';
  returnTo?: string;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function isStartChallengeResponse(value: unknown): value is StartChallengeResponse {
  return (
    isRecord(value) &&
    typeof value.challenge === 'string' &&
    TOKEN_PATTERN.test(value.challenge) &&
    typeof value.expiresAt === 'string' &&
    Number.isFinite(Date.parse(value.expiresAt))
  );
}

function isConfirmChallengeResponse(value: unknown): value is ConfirmChallengeResponse {
  return (
    isRecord(value) &&
    typeof value.sessionToken === 'string' &&
    TOKEN_PATTERN.test(value.sessionToken) &&
    value.tokenType === 'Bearer' &&
    typeof value.expiresAt === 'string' &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    typeof value.elevatedUntil === 'string' &&
    Number.isFinite(Date.parse(value.elevatedUntil))
  );
}

function isCurrentUserResponse(value: unknown): value is CurrentUserResponse {
  return isRecord(value) && typeof value.id === 'string' && typeof value.email === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function signInRedirect(request: Request, frontendOrigin: string, returnTo: string): Response {
  const headers = new Headers();
  clearSessionCookie(request, headers, frontendOrigin);
  clearAdminMfaChallengeCookie(request, headers, { frontendOrigin });

  const challengePath = `/admin/mfa/challenge?returnTo=${encodeURIComponent(returnTo)}`;
  return redirect(`/login?returnTo=${encodeURIComponent(challengePath)}`, { headers });
}

export async function loader({ request }: Route.LoaderArgs) {
  const config = loadFrontendConfig();
  const protectedUser = await loadProtectedUser(request, config);
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get('returnTo'));

  if (protectedUser.status === 'unavailable') {
    return data({ status: 'unavailable' as const, returnTo }, { headers });
  }

  if (protectedUser.status === 'restricted') {
    return data({ status: 'restricted' as const, returnTo }, { headers });
  }

  return data(
    {
      status: 'authenticated' as const,
      csrfToken: protectedUser.csrfToken,
      hasChallenge: Boolean(readAdminMfaChallenge(request.headers.get('cookie'))),
      returnTo,
    },
    { headers },
  );
}

export async function action({ request }: Route.ActionArgs) {
  const config = loadFrontendConfig();
  const sessionToken = readSessionToken(request.headers.get('cookie'));
  let submittedStep: 'start' | 'confirm' | undefined;
  let returnTo = safeReturnTo(new URL(request.url).searchParams.get('returnTo'));
  let sessionWasConfirmed = false;

  if (!sessionToken) {
    const headers = new Headers();

    if (request.headers.get('cookie')?.includes('tx_session=')) {
      clearSessionCookie(request, headers, config.frontendOrigin);
    }

    clearAdminMfaChallengeCookie(request, headers, { frontendOrigin: config.frontendOrigin });
    return redirect(
      `/login?returnTo=${encodeURIComponent(`/admin/mfa/challenge?returnTo=${encodeURIComponent(returnTo)}`)}`,
      { headers },
    );
  }

  try {
    return await withProtectedSessionFormRequest(request, sessionToken, config, async (form) => {
      const step = form.get('step');
      submittedStep = step === 'confirm' ? 'confirm' : 'start';
      returnTo = safeReturnTo(
        typeof form.get('returnTo') === 'string' ? String(form.get('returnTo')) : returnTo,
      );

      const headers = { authorization: `Bearer ${sessionToken}` };

      if (submittedStep === 'confirm') {
        const challenge = readAdminMfaChallenge(request.headers.get('cookie'));

        if (!challenge) {
          return data<ChallengeActionData>(
            { status: 'invalid', step: 'start', returnTo },
            { status: 400, headers: { 'Cache-Control': 'private, no-store' } },
          );
        }
      }

      await requestJson<CurrentUserResponse>('/auth/me', {
        headers,
        signal: request.signal,
        validateData: isCurrentUserResponse,
      });
      sessionWasConfirmed = true;

      if (submittedStep === 'start') {
        const passwordValue = form.get('password');
        const password = typeof passwordValue === 'string' ? passwordValue : '';

        if (password.length === 0 || password.length > 1024) {
          return data<ChallengeActionData>(
            { status: 'invalid', step: 'start', returnTo },
            { status: 400, headers: { 'Cache-Control': 'private, no-store' } },
          );
        }

        const result = await requestJson<StartChallengeResponse>('/admin/mfa/elevation/challenge', {
          method: 'POST',
          headers,
          body: { password },
          signal: request.signal,
          validateData: isStartChallengeResponse,
        });

        const responseHeaders = new Headers({ 'Cache-Control': 'private, no-store' });
        appendAdminMfaChallengeCookie(
          request,
          responseHeaders,
          result.challenge,
          result.expiresAt,
          { frontendOrigin: config.frontendOrigin },
        );

        return data<ChallengeActionData>(
          { status: 'challenge', returnTo },
          { headers: responseHeaders },
        );
      }

      const codeValue = form.get('code');
      const code = typeof codeValue === 'string' ? codeValue.trim() : '';

      if (!/^\d{6}$/u.test(code)) {
        return data<ChallengeActionData>(
          { status: 'invalid', step: 'confirm', returnTo },
          { status: 400, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }

      const challenge = readAdminMfaChallenge(request.headers.get('cookie'));

      if (!challenge) {
        return data<ChallengeActionData>(
          { status: 'invalid', step: 'start', returnTo },
          { status: 400, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }

      const result = await requestJson<ConfirmChallengeResponse>('/admin/mfa/elevation/confirm', {
        method: 'POST',
        headers,
        body: { challenge, code },
        signal: request.signal,
        validateData: isConfirmChallengeResponse,
      });

      const responseHeaders = new Headers({ 'Cache-Control': 'private, no-store' });
      appendSessionCookie(request, responseHeaders, result.sessionToken, result.expiresAt, config);
      clearAdminMfaChallengeCookie(request, responseHeaders, {
        frontendOrigin: config.frontendOrigin,
      });

      // The Admin shell is scheduled for 5.16, so Buyer is the safe default.
      return redirect(returnTo, { headers: responseHeaders });
    });
  } catch (error) {
    if (
      request.signal.aborted ||
      (error instanceof ApiRequestError && error.kind === 'cancelled')
    ) {
      throw error;
    }

    if (error instanceof RequestProtectionError) {
      return data<ChallengeActionData>(
        { status: 'blocked', returnTo },
        { status: error.status, headers: { 'Cache-Control': 'private, no-store' } },
      );
    }

    if (error instanceof ApiRequestError && error.kind === 'http') {
      if (error.status === 401 && (!sessionWasConfirmed || submittedStep === 'confirm')) {
        return signInRedirect(request, config.frontendOrigin, returnTo);
      }

      if (error.status === 401 && submittedStep === 'start') {
        return data<ChallengeActionData>(
          { status: 'invalid', step: 'start', returnTo },
          { status: 401, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }

      if (error.status === 400) {
        const responseHeaders = new Headers({ 'Cache-Control': 'private, no-store' });

        if (submittedStep === 'confirm') {
          clearAdminMfaChallengeCookie(request, responseHeaders, {
            frontendOrigin: config.frontendOrigin,
          });
        }

        return data<ChallengeActionData>(
          { status: 'invalid', step: 'start', returnTo },
          { status: 400, headers: responseHeaders },
        );
      }

      if (error.status === 403) {
        const responseHeaders = new Headers({ 'Cache-Control': 'private, no-store' });
        clearAdminMfaChallengeCookie(request, responseHeaders, {
          frontendOrigin: config.frontendOrigin,
        });

        return data<ChallengeActionData>(
          { status: 'denied', returnTo },
          { status: 403, headers: responseHeaders },
        );
      }

      if (error.status === 429) {
        return data<ChallengeActionData>(
          { status: 'limited', step: submittedStep, returnTo },
          { status: 429, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }
    }

    return data<ChallengeActionData>(
      { status: 'unavailable', step: submittedStep, returnTo },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
}

export default function AdminMfaChallengePage() {
  const page = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as ChallengeActionData | undefined;
  const isSubmitting = fetcher.state === 'submitting';

  if (page.status === 'unavailable') {
    return (
      <AuthPageShell>
        <AuthCard>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
            Administrator access unavailable
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
            Administrator access unavailable
          </h1>
          <Alert>Administrator access is unavailable for this account.</Alert>
          <Link className="mt-5 inline-flex font-semibold text-forest underline" to="/account">
            Return to your account
          </Link>
        </AuthCard>
      </AuthPageShell>
    );
  }

  if (result?.status === 'denied') {
    return (
      <AuthPageShell>
        <AuthCard>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
            Administrator access unavailable
          </h1>
          <Alert>Your administrator permission or MFA access is unavailable.</Alert>
          <Link className="mt-5 inline-flex font-semibold text-forest underline" to="/account">
            Return to your account
          </Link>
        </AuthCard>
      </AuthPageShell>
    );
  }

  const confirming =
    page.status === 'authenticated' &&
    (page.hasChallenge || result?.status === 'challenge' || result?.step === 'confirm');

  return (
    <AuthPageShell>
      <AuthCard>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
          Verify administrator access
        </h1>
        <p className="mt-3 leading-7 text-muted">
          Enter your current password, then confirm with your authenticator.
        </p>

        {result?.status === 'invalid' && (
          <div className="mt-6">
            <Alert>
              {result.step === 'confirm'
                ? 'Enter the current six-digit code from your authenticator.'
                : 'The password, code, or challenge could not be verified. Start again and try a current code.'}
            </Alert>
          </div>
        )}
        {result?.status === 'limited' && (
          <div className="mt-6">
            <Alert>Too many attempts. Wait 15 minutes before trying again.</Alert>
          </div>
        )}
        {result?.status === 'unavailable' && (
          <div className="mt-6">
            <Alert>Administrator verification is temporarily unavailable. Please retry.</Alert>
          </div>
        )}
        {result?.status === 'blocked' && (
          <div className="mt-6">
            <Alert>We could not verify this request. Refresh the page and try again.</Alert>
          </div>
        )}

        {page.status === 'authenticated' && !confirming && (
          <fetcher.Form
            action="/admin/mfa/challenge"
            className="mt-8 space-y-6"
            method="post"
            noValidate
            aria-busy={isSubmitting}
          >
            <input name="csrfToken" type="hidden" value={page.csrfToken} />
            <input name="step" type="hidden" value="start" />
            <input name="returnTo" type="hidden" value={page.returnTo} />
            <PasswordField autoComplete="current-password" label="Current password" />
            <Button disabled={isSubmitting} type="submit">
              {isSubmitting ? 'Checking password…' : 'Continue'}
            </Button>
            <p aria-live="polite" className="sr-only" role="status">
              {isSubmitting ? 'Checking administrator credentials…' : ''}
            </p>
          </fetcher.Form>
        )}

        {page.status === 'authenticated' && confirming && (
          <>
            <fetcher.Form
              action="/admin/mfa/challenge"
              className="mt-8 space-y-6"
              method="post"
              noValidate
              aria-busy={isSubmitting}
            >
              <input name="csrfToken" type="hidden" value={page.csrfToken} />
              <input name="step" type="hidden" value="confirm" />
              <input name="returnTo" type="hidden" value={result?.returnTo ?? page.returnTo} />
              <FormField id="code" label="Six-digit authenticator code">
                <input
                  autoComplete="one-time-code"
                  className="min-h-12 w-full rounded-xl border border-stone-300 bg-white px-4 font-mono text-ink outline-none focus:border-forest focus:ring-2 focus:ring-forest/15"
                  id="code"
                  inputMode="numeric"
                  maxLength={6}
                  name="code"
                  pattern="[0-9]{6}"
                  required
                />
              </FormField>
              <Button disabled={isSubmitting} type="submit">
                {isSubmitting ? 'Verifying…' : 'Verify and continue'}
              </Button>
              <p aria-live="polite" className="sr-only" role="status">
                {isSubmitting ? 'Verifying administrator access…' : ''}
              </p>
            </fetcher.Form>
            <p className="mt-6 text-sm text-muted">
              Lost access to your authenticator?{' '}
              <Link className="font-semibold text-forest underline" to="/admin/mfa/recovery">
                Recover administrator access
              </Link>
            </p>
          </>
        )}
      </AuthCard>
    </AuthPageShell>
  );
}
