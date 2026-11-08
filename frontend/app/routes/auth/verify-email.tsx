import type { Route } from './+types/verify-email';
import { Alert } from '~/components/Alert.js';
import { AuthCard, AuthPageShell } from '~/features/auth/AuthLayout.js';
import { Button } from '~/components/Button.js';
import { PasswordField } from '~/components/PasswordField.js';
import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { loadFrontendConfig } from '~/.server/env.js';
import {
  issueCsrfToken,
  RequestProtectionError,
  withProtectedFormRequest,
} from '~/.server/auth/request-protection.js';
import { data, Link, useFetcher, useLoaderData, useSearchParams } from 'react-router';

interface VerifyResponseData {
  status: 'verified';
}

interface VerifyActionData {
  status: 'verified' | 'invalid' | 'rejected' | 'limited' | 'unavailable' | 'blocked';
  fieldErrors?: { token?: string; password?: string };
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function isVerifyResponse(value: unknown): value is VerifyResponseData {
  return (
    typeof value === 'object' && value !== null && 'status' in value && value.status === 'verified'
  );
}

export function loader({ request }: Route.LoaderArgs) {
  const headers = new Headers();
  const csrfToken = issueCsrfToken(request, headers, loadFrontendConfig());
  return data({ csrfToken }, { headers });
}

export async function action({ request }: Route.ActionArgs) {
  const config = loadFrontendConfig();

  try {
    return await withProtectedFormRequest(request, config, async (form) => {
      const tokenValue = form.get('token');
      const passwordValue = form.get('password');
      const token = typeof tokenValue === 'string' ? tokenValue : '';
      const password = typeof passwordValue === 'string' ? passwordValue : '';

      if (!TOKEN_PATTERN.test(token)) {
        return data<VerifyActionData>(
          { status: 'invalid', fieldErrors: { token: 'This verification link is invalid.' } },
          { status: 400 },
        );
      }

      if (password.length === 0) {
        return data<VerifyActionData>(
          { status: 'invalid', fieldErrors: { password: 'Enter your signup password.' } },
          { status: 400 },
        );
      }

      try {
        await requestJson<VerifyResponseData>('/auth/verify-email', {
          method: 'POST',
          body: { token, password },
          signal: request.signal,
          validateData: isVerifyResponse,
        });

        return { status: 'verified' } satisfies VerifyActionData;
      } catch (error) {
        if (
          request.signal.aborted ||
          (error instanceof ApiRequestError && error.kind === 'cancelled')
        ) {
          throw error;
        }

        if (error instanceof ApiRequestError) {
          if (error.status === 401 && error.errorCode === 'REQUEST_ERROR') {
            return data<VerifyActionData>({ status: 'rejected' }, { status: 401 });
          }

          if (error.status === 429) {
            return data<VerifyActionData>({ status: 'limited' }, { status: 429 });
          }

          if (error.status === 400 && error.errorCode === 'VALIDATION_ERROR') {
            return data<VerifyActionData>(
              { status: 'invalid', fieldErrors: mapValidationDetails(error.details ?? []) },
              { status: 400 },
            );
          }
        }

        return data<VerifyActionData>({ status: 'unavailable' }, { status: 503 });
      }
    });
  } catch (error) {
    if (request.signal.aborted) throw error;

    if (error instanceof RequestProtectionError) {
      return data<VerifyActionData>({ status: 'blocked' }, { status: error.status });
    }

    return data<VerifyActionData>({ status: 'unavailable' }, { status: 503 });
  }
}

function mapValidationDetails(
  details: NonNullable<ApiRequestError['details']>,
): VerifyActionData['fieldErrors'] {
  const fieldErrors: NonNullable<VerifyActionData['fieldErrors']> = {};

  for (const detail of details) {
    const field = detail.field.split('/').at(-1)?.split('.').at(-1);

    if (field === 'password') {
      fieldErrors.password = 'Enter the password you chose when you created your account.';
    } else if (field === 'token') {
      fieldErrors.token = 'This verification link is invalid.';
    }
  }

  return fieldErrors;
}

export default function VerifyEmailPage() {
  const { csrfToken } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const tokenIsValid = TOKEN_PATTERN.test(token);
  const fetcher = useFetcher<typeof action>();
  const actionData = fetcher.data as VerifyActionData | undefined;
  const isSubmitting = fetcher.state === 'submitting';

  if (actionData?.status === 'verified') {
    return (
      <AuthPageShell>
        <AuthCard>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">Email verified</h1>
          <p className="mt-3 leading-7 text-muted">Your email address is verified.</p>
          <Link className="mt-6 inline-flex font-semibold text-forest underline" to="/">
            Continue to Tennis Xpress
          </Link>
        </AuthCard>
      </AuthPageShell>
    );
  }

  const rejected = actionData?.status === 'rejected';
  const invalidLink = !tokenIsValid || Boolean(actionData?.fieldErrors?.token);

  return (
    <AuthPageShell>
      <AuthCard>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">Verify your email</h1>
        <p className="mt-3 leading-7 text-muted">
          Enter the password you chose when you created your account.
        </p>

        {rejected && (
          <div className="mt-6">
            <Alert>
              We couldn’t verify this link and password. Check your password or request a new link.
            </Alert>
          </div>
        )}
        {actionData?.status === 'limited' && (
          <div className="mt-6">
            <Alert>Too many attempts. Wait a little while, then try again.</Alert>
          </div>
        )}
        {actionData?.status === 'unavailable' && (
          <div className="mt-6">
            <Alert>Verification is temporarily unavailable. Please try again.</Alert>
          </div>
        )}
        {actionData?.status === 'blocked' && (
          <div className="mt-6">
            <Alert>We couldn’t verify this request. Refresh the page and try again.</Alert>
          </div>
        )}
        {actionData?.status === 'invalid' &&
          !actionData.fieldErrors?.token &&
          !actionData.fieldErrors?.password && (
            <div className="mt-6">
              <Alert>
                We couldn’t verify those details. Check the link and password, then try again.
              </Alert>
            </div>
          )}

        {invalidLink && (
          <div className="mt-6">
            <Alert>This verification link is invalid or incomplete.</Alert>
          </div>
        )}

        {(rejected || invalidLink) && (
          <p className="mt-4 text-sm text-muted">
            <Link className="font-semibold text-forest underline" to="/resend-verification">
              Request a new verification link
            </Link>
          </p>
        )}

        {tokenIsValid && (
          <fetcher.Form
            action="/verify-email"
            className="mt-8 space-y-6"
            method="post"
            noValidate
            aria-busy={isSubmitting}
          >
            <input name="csrfToken" type="hidden" value={csrfToken} />
            <input name="token" type="hidden" value={token} />

            <PasswordField
              autoComplete="current-password"
              hint="Use the password you chose when you created your account."
              error={actionData?.fieldErrors?.password}
            />

            <Button disabled={isSubmitting} type="submit">
              {isSubmitting ? 'Verifying…' : 'Verify email'}
            </Button>
            <p className="sr-only" role="status" aria-live="polite">
              {isSubmitting ? 'Verifying your email…' : ''}
            </p>
          </fetcher.Form>
        )}
      </AuthCard>
    </AuthPageShell>
  );
}
