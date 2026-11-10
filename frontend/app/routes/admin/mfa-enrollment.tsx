import type { Route } from './+types/mfa-enrollment';
import { Alert } from '~/components/Alert.js';
import { Button } from '~/components/Button.js';
import { FormField } from '~/components/FormField.js';
import { PasswordField } from '~/components/PasswordField.js';
import { AuthCard, AuthPageShell } from '~/features/auth/AuthLayout.js';
import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { loadFrontendConfig } from '~/.server/env.js';
import {
  clearAdminEnrollmentAuthorizationCookie,
  readAdminEnrollmentAuthorization,
} from '~/.server/auth/admin-mfa.js';
import {
  RequestProtectionError,
  withProtectedSessionFormRequest,
} from '~/.server/auth/request-protection.js';
import { clearSessionCookie, loadProtectedUser, readSessionToken } from '~/.server/auth/session.js';
import { data, Link, redirect, useFetcher, useLoaderData } from 'react-router';

interface EnrollmentSetup {
  secret: string;
  provisioningUri: string;
  expiresAt: string;
}

interface EnrollmentActionData {
  status:
    | 'setup'
    | 'enrolled'
    | 'invalid'
    | 'denied'
    | 'limited'
    | 'conflict'
    | 'unavailable'
    | 'blocked';
  step?: 'start' | 'confirm';
  setup?: EnrollmentSetup;
  recoveryCodes?: string[];
  fieldErrors?: {
    authorization?: string;
    password?: string;
    code?: string;
  };
}

interface StartEnrollmentResponse {
  secret: string;
  provisioningUri: string;
  expiresAt: string;
}

interface ConfirmEnrollmentResponse {
  status: 'enrolled';
  recoveryCodes: string[];
}

interface CurrentUserResponse {
  id: string;
  email: string;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SECRET_PATTERN = /^[A-Z2-7]{32,64}$/u;
const RECOVERY_CODE_PATTERN = /^[A-F0-9]{8}(-[A-F0-9]{8}){3}$/u;

function isStartEnrollmentResponse(value: unknown): value is StartEnrollmentResponse {
  return (
    isRecord(value) &&
    typeof value.secret === 'string' &&
    SECRET_PATTERN.test(value.secret) &&
    typeof value.provisioningUri === 'string' &&
    value.provisioningUri.startsWith('otpauth://totp/') &&
    typeof value.expiresAt === 'string' &&
    Number.isFinite(Date.parse(value.expiresAt))
  );
}

function isConfirmEnrollmentResponse(value: unknown): value is ConfirmEnrollmentResponse {
  return (
    isRecord(value) &&
    value.status === 'enrolled' &&
    Array.isArray(value.recoveryCodes) &&
    value.recoveryCodes.length === 10 &&
    value.recoveryCodes.every(
      (code) => typeof code === 'string' && RECOVERY_CODE_PATTERN.test(code),
    )
  );
}

function isCurrentUserResponse(value: unknown): value is CurrentUserResponse {
  return isRecord(value) && typeof value.id === 'string' && typeof value.email === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSetup(form: URLSearchParams): EnrollmentSetup | undefined {
  const secret = form.get('setupSecret') ?? '';
  const provisioningUri = form.get('setupUri') ?? '';
  const expiresAt = form.get('setupExpiresAt') ?? '';

  if (
    !SECRET_PATTERN.test(secret) ||
    !provisioningUri.startsWith('otpauth://totp/') ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    return undefined;
  }

  return { secret, provisioningUri, expiresAt };
}

function signInRedirect(request: Request, frontendOrigin: string): Response {
  const headers = new Headers();
  clearSessionCookie(request, headers, frontendOrigin);
  return redirect('/login?returnTo=%2Fadmin%2Fmfa%2Fenrollment', { headers });
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
      hasRecoveryAuthorization: Boolean(
        readAdminEnrollmentAuthorization(request.headers.get('cookie')),
      ),
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

    return redirect('/login?returnTo=%2Fadmin%2Fmfa%2Fenrollment', { headers });
  }

  let submittedStep: 'start' | 'confirm' | undefined;
  let submittedSetup: EnrollmentSetup | undefined;
  let sessionWasConfirmed = false;

  try {
    return await withProtectedSessionFormRequest(request, sessionToken, config, async (form) => {
      const step = form.get('step');
      submittedStep = step === 'confirm' ? 'confirm' : 'start';
      submittedSetup = submittedStep === 'confirm' ? readSetup(form) : undefined;

      // Check that the bearer session is still valid after CSRF validation
      // and before attempting an MFA operation.
      await requestJson<CurrentUserResponse>('/auth/me', {
        headers: { authorization: `Bearer ${sessionToken}` },
        signal: request.signal,
        validateData: isCurrentUserResponse,
      });
      sessionWasConfirmed = true;

      if (submittedStep === 'start') {
        const passwordValue = form.get('password');
        const authorizationValue = form.get('authorization');
        const password = typeof passwordValue === 'string' ? passwordValue : '';
        const submittedAuthorization =
          typeof authorizationValue === 'string' ? authorizationValue.trim() : '';
        const cookieAuthorization = readAdminEnrollmentAuthorization(request.headers.get('cookie'));
        const authorization = submittedAuthorization || cookieAuthorization || '';
        const fieldErrors: NonNullable<EnrollmentActionData['fieldErrors']> = {};

        if (!TOKEN_PATTERN.test(authorization)) {
          fieldErrors.authorization = 'Enter the authorization supplied for this enrollment.';
        }

        if (password.length === 0 || password.length > 1024) {
          fieldErrors.password = 'Enter your current password.';
        }

        if (fieldErrors.authorization || fieldErrors.password) {
          return data<EnrollmentActionData>(
            { status: 'invalid', step: 'start', fieldErrors },
            { status: 400 },
          );
        }

        const setup = await requestJson<StartEnrollmentResponse>('/admin/mfa/enrollment', {
          method: 'POST',
          headers: { authorization: `Bearer ${sessionToken}` },
          body: { password, authorization },
          signal: request.signal,
          validateData: isStartEnrollmentResponse,
        });

        const headers = new Headers({ 'Cache-Control': 'private, no-store' });

        if (cookieAuthorization && authorization === cookieAuthorization) {
          clearAdminEnrollmentAuthorizationCookie(request, headers, config);
        }

        return data<EnrollmentActionData>(
          {
            status: 'setup',
            setup,
          },
          { headers },
        );
      }

      const codeValue = form.get('code');
      const code = typeof codeValue === 'string' ? codeValue.trim() : '';

      if (!submittedSetup) {
        return data<EnrollmentActionData>(
          {
            status: 'invalid',
            step: 'confirm',
            fieldErrors: { code: 'Restart setup before confirming the authenticator.' },
          },
          { status: 400 },
        );
      }

      if (!/^\d{6}$/u.test(code)) {
        return data<EnrollmentActionData>(
          {
            status: 'invalid',
            step: 'confirm',
            setup: submittedSetup,
            fieldErrors: { code: 'Enter the six-digit code from your authenticator.' },
          },
          { status: 400 },
        );
      }

      const confirmed = await requestJson<ConfirmEnrollmentResponse>(
        '/admin/mfa/enrollment/confirm',
        {
          method: 'POST',
          headers: { authorization: `Bearer ${sessionToken}` },
          body: { code },
          signal: request.signal,
          validateData: isConfirmEnrollmentResponse,
        },
      );

      return data<EnrollmentActionData>(
        { status: 'enrolled', recoveryCodes: confirmed.recoveryCodes },
        { headers: { 'Cache-Control': 'private, no-store' } },
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
      return data<EnrollmentActionData>(
        { status: 'blocked' },
        { status: error.status, headers: { 'Cache-Control': 'private, no-store' } },
      );
    }

    if (error instanceof ApiRequestError && error.kind === 'http') {
      if (error.status === 401 && (!sessionWasConfirmed || submittedStep === 'confirm')) {
        return signInRedirect(request, config.frontendOrigin);
      }

      if (error.status === 401 && submittedStep === 'start') {
        return data<EnrollmentActionData>(
          {
            status: 'invalid',
            step: 'start',
            fieldErrors: {
              password: 'Check your password and enrollment authorization.',
            },
          },
          { status: 401, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }

      if (error.status === 400) {
        return data<EnrollmentActionData>(
          {
            status: 'invalid',
            step: submittedStep ?? 'start',
            ...(submittedStep === 'confirm' && submittedSetup ? { setup: submittedSetup } : {}),
            ...(submittedStep === 'confirm'
              ? { fieldErrors: { code: 'That code is invalid or expired. Try a current code.' } }
              : {
                  fieldErrors: {
                    authorization: 'This enrollment authorization is invalid or expired.',
                  },
                }),
          },
          { status: 400, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }

      if (error.status === 403) {
        return data<EnrollmentActionData>(
          { status: 'denied' },
          { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }

      if (error.status === 409) {
        return data<EnrollmentActionData>(
          { status: 'conflict' },
          { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }

      if (error.status === 429) {
        return data<EnrollmentActionData>(
          {
            status: 'limited',
            ...(submittedStep === 'confirm' && submittedSetup ? { setup: submittedSetup } : {}),
          },
          { status: 429, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }
    }

    return data<EnrollmentActionData>(
      {
        status: 'unavailable',
        ...(submittedStep === 'confirm' && submittedSetup ? { setup: submittedSetup } : {}),
      },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
}

export default function AdminMfaEnrollmentPage() {
  const page = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as EnrollmentActionData | undefined;
  const isSubmitting = fetcher.state === 'submitting';
  const setup = result?.status === 'setup' ? result.setup : result?.setup;

  if (page.status === 'unavailable') {
    return (
      <AuthPageShell>
        <AuthCard>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
            Enrollment unavailable
          </h1>
          <Alert>Administrator setup is temporarily unavailable. Please retry.</Alert>
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
            Administrator setup unavailable
          </h1>
          <Alert>Administrator setup is unavailable for this account.</Alert>
          <Link className="mt-5 inline-flex font-semibold text-forest underline" to="/account">
            Return to your account
          </Link>
        </AuthCard>
      </AuthPageShell>
    );
  }

  if (result?.status === 'enrolled') {
    return (
      <AuthPageShell>
        <AuthCard>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
            Save your recovery codes
          </h1>
          <p className="mt-3 leading-7 text-muted">
            Each code works once. Store these somewhere safe; they will not be shown again.
          </p>
          <ol className="mt-6 grid gap-2 rounded-xl bg-stone-50 p-4 font-mono text-sm">
            {result.recoveryCodes?.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ol>
          <p className="mt-4 text-sm text-muted" role="status">
            MFA is enrolled. Administrator access still requires a separate elevation.
          </p>
          <Link className="mt-6 inline-flex font-semibold text-forest underline" to="/account">
            Continue
          </Link>
        </AuthCard>
      </AuthPageShell>
    );
  }

  return (
    <AuthPageShell>
      <AuthCard>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
          Set up administrator verification
        </h1>
        <p className="mt-3 leading-7 text-muted">
          Use an authenticator app to protect administrator access. Setup expires after ten minutes.
        </p>

        {result?.status === 'denied' && (
          <div className="mt-6">
            <Alert>Administrator setup is not available for this account.</Alert>
          </div>
        )}
        {result?.status === 'conflict' && (
          <div className="mt-6">
            <Alert>
              An authenticator is already active or setup is already in progress. Contact support if
              you cannot continue.
            </Alert>
          </div>
        )}
        {result?.status === 'conflict' && (
          <p className="mt-4 text-sm text-muted">
            Lost access to your authenticator?{' '}
            <Link className="font-semibold text-forest underline" to="/admin/mfa/recovery">
              Recover administrator access
            </Link>
          </p>
        )}
        {result?.status === 'limited' && (
          <div className="mt-6">
            <Alert>Too many attempts. Wait 15 minutes before trying again.</Alert>
          </div>
        )}
        {result?.status === 'unavailable' && (
          <div className="mt-6">
            <Alert>Administrator setup is temporarily unavailable. Please retry.</Alert>
          </div>
        )}
        {result?.status === 'blocked' && (
          <div className="mt-6">
            <Alert>We could not verify this request. Refresh the page and try again.</Alert>
          </div>
        )}
        {result?.status === 'invalid' && result.step === 'start' && (
          <div className="mt-6">
            <Alert>Check the marked fields and try again.</Alert>
          </div>
        )}
        {result?.status === 'invalid' && result.step === 'confirm' && (
          <div className="mt-6">
            <Alert>We could not confirm that code. Use a current code and try again.</Alert>
          </div>
        )}

        {!setup && (
          <fetcher.Form
            action="/admin/mfa/enrollment"
            className="mt-8 space-y-6"
            method="post"
            noValidate
            aria-busy={isSubmitting}
          >
            <input name="csrfToken" type="hidden" value={page.csrfToken} />
            <input name="step" type="hidden" value="start" />

            <FormField
              id="authorization"
              label="Enrollment authorization"
              error={
                result?.status === 'invalid' && result.step === 'start'
                  ? result.fieldErrors?.authorization
                  : undefined
              }
              hint={
                page.hasRecoveryAuthorization
                  ? 'A recovery authorization is available in this browser. You can also enter a new one.'
                  : 'Enter the one-time authorization given to you by an operator.'
              }
            >
              <input
                aria-invalid={Boolean(
                  result?.status === 'invalid' &&
                  result.step === 'start' &&
                  result.fieldErrors?.authorization,
                )}
                autoComplete="off"
                className="min-h-12 w-full rounded-xl border border-stone-300 bg-white px-4 text-ink outline-none focus:border-forest focus:ring-2 focus:ring-forest/15"
                id="authorization"
                name="authorization"
                type="password"
              />
            </FormField>

            <PasswordField autoComplete="current-password" label="Current password" />
            <Button disabled={isSubmitting} type="submit">
              {isSubmitting ? 'Starting setup…' : 'Start setup'}
            </Button>
            <p aria-live="polite" className="sr-only" role="status">
              {isSubmitting ? 'Starting administrator setup…' : ''}
            </p>
          </fetcher.Form>
        )}

        {setup && (
          <section aria-labelledby="authenticator-heading" className="mt-8 space-y-6">
            <h2 className="text-xl font-semibold text-ink" id="authenticator-heading">
              Set up your authenticator
            </h2>
            <p className="leading-6 text-muted">
              Add this account using the provisioning link or enter the setup key manually.
            </p>
            <FormField id="provisioning-uri" label="Authenticator setup link">
              <textarea
                className="min-h-24 w-full break-all rounded-xl border border-stone-300 bg-white p-3 font-mono text-xs text-ink"
                id="provisioning-uri"
                readOnly
                value={setup.provisioningUri}
              />
            </FormField>
            <FormField
              id="setup-secret"
              label="Manual setup key"
              hint={`Setup expires ${new Date(setup.expiresAt).toLocaleString()}.`}
            >
              <input
                className="min-h-12 w-full rounded-xl border border-stone-300 bg-white px-4 font-mono text-ink"
                id="setup-secret"
                readOnly
                value={setup.secret}
              />
            </FormField>

            {result?.status === 'invalid' && result.step === 'confirm' && (
              <Alert>{result.fieldErrors?.code ?? 'Enter a current six-digit code.'}</Alert>
            )}

            <fetcher.Form
              action="/admin/mfa/enrollment"
              className="space-y-6"
              method="post"
              noValidate
              aria-busy={isSubmitting}
            >
              <input name="csrfToken" type="hidden" value={page.csrfToken} />
              <input name="step" type="hidden" value="confirm" />
              <input name="setupSecret" type="hidden" value={setup.secret} />
              <input name="setupUri" type="hidden" value={setup.provisioningUri} />
              <input name="setupExpiresAt" type="hidden" value={setup.expiresAt} />

              <FormField
                id="code"
                label="Six-digit authenticator code"
                error={
                  result?.status === 'invalid' && result.step === 'confirm'
                    ? result.fieldErrors?.code
                    : undefined
                }
              >
                <input
                  aria-invalid={Boolean(
                    result?.status === 'invalid' &&
                    result.step === 'confirm' &&
                    result.fieldErrors?.code,
                  )}
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
                {isSubmitting ? 'Confirming…' : 'Confirm authenticator'}
              </Button>
              <p aria-live="polite" className="sr-only" role="status">
                {isSubmitting ? 'Confirming administrator authenticator…' : ''}
              </p>
            </fetcher.Form>
          </section>
        )}
      </AuthCard>
    </AuthPageShell>
  );
}
