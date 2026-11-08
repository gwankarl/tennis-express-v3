import type { Route } from './+types/reset-password';
import { Alert } from '~/components/Alert.js';
import { AuthCard, AuthPageShell } from '~/components/AuthPageShell.js';
import { Button } from '~/components/Button.js';
import { PasswordField } from '~/components/PasswordField.js';
import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { loadFrontendConfig } from '~/.server/env.js';
import {
  issueCsrfToken,
  RequestProtectionError,
  withProtectedFormRequest,
} from '~/.server/request-protection.js';
import { data, Link, redirect, useFetcher, useLoaderData, useSearchParams } from 'react-router';

interface ResetPasswordResponseData {
  status: 'reset';
}

interface ResetPasswordActionData {
  status: 'invalid' | 'unusable' | 'limited' | 'unavailable' | 'blocked';
  fieldErrors?: { password?: string };
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function isResetPasswordResponse(value: unknown): value is ResetPasswordResponseData {
  return (
    typeof value === 'object' && value !== null && 'status' in value && value.status === 'reset'
  );
}

export function loader({ request }: Route.LoaderArgs) {
  const headers = new Headers();
  const csrfToken = issueCsrfToken(request, headers, loadFrontendConfig());

  // The reset token stays in the link URL and is not returned as loader data.
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
        return data<ResetPasswordActionData>({ status: 'unusable' }, { status: 400 });
      }

      const codePointCount = [...password.normalize('NFC')].length;

      if (codePointCount < 15 || codePointCount > 128) {
        return data<ResetPasswordActionData>(
          {
            status: 'invalid',
            fieldErrors: {
              password: 'Use 15–128 characters. A passphrase works well.',
            },
          },
          { status: 400 },
        );
      }

      try {
        await requestJson<ResetPasswordResponseData>('/auth/reset-password', {
          method: 'POST',
          body: { token, password },
          signal: request.signal,
          validateData: isResetPasswordResponse,
        });

        return redirect('/login?passwordReset=success');
      } catch (error) {
        if (
          request.signal.aborted ||
          (error instanceof ApiRequestError && error.kind === 'cancelled')
        ) {
          throw error;
        }

        if (
          error instanceof ApiRequestError &&
          error.kind === 'http' &&
          error.status === 401 &&
          error.errorCode === 'REQUEST_ERROR'
        ) {
          return data<ResetPasswordActionData>({ status: 'unusable' }, { status: 401 });
        }

        if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 429) {
          return data<ResetPasswordActionData>({ status: 'limited' }, { status: 429 });
        }

        if (
          error instanceof ApiRequestError &&
          error.kind === 'http' &&
          error.status === 400 &&
          error.errorCode === 'VALIDATION_ERROR'
        ) {
          const passwordHasPolicyError = (error.details ?? []).some(
            (detail) => detail.field.split('/').at(-1) === 'password',
          );

          if (passwordHasPolicyError) {
            return data<ResetPasswordActionData>(
              {
                status: 'invalid',
                fieldErrors: {
                  password: 'Use 15–128 characters. A passphrase works well.',
                },
              },
              { status: 400 },
            );
          }
        }

        return data<ResetPasswordActionData>({ status: 'unavailable' }, { status: 503 });
      }
    });
  } catch (error) {
    if (request.signal.aborted) throw error;

    if (error instanceof RequestProtectionError) {
      return data<ResetPasswordActionData>({ status: 'blocked' }, { status: error.status });
    }

    return data<ResetPasswordActionData>({ status: 'unavailable' }, { status: 503 });
  }
}

export default function ResetPasswordPage() {
  const { csrfToken } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const tokenIsValid = TOKEN_PATTERN.test(token);
  const fetcher = useFetcher<typeof action>();
  const actionData = fetcher.data as ResetPasswordActionData | undefined;
  const isSubmitting = fetcher.state === 'submitting';
  const linkIsUnusable = !tokenIsValid || actionData?.status === 'unusable';

  return (
    <AuthPageShell>
      <AuthCard>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
          Choose a new password
        </h1>
        <p className="mt-3 leading-7 text-muted">Use 15–128 characters. A passphrase works well.</p>

        {linkIsUnusable && (
          <div className="mt-6">
            <Alert>This reset link is invalid, expired, or already used.</Alert>
          </div>
        )}
        {actionData?.status === 'limited' && (
          <div className="mt-6">
            <Alert>Too many attempts. Wait a little while, then try again.</Alert>
          </div>
        )}
        {actionData?.status === 'unavailable' && (
          <div className="mt-6">
            <Alert>Password reset is temporarily unavailable. Please try again.</Alert>
          </div>
        )}
        {actionData?.status === 'blocked' && (
          <div className="mt-6">
            <Alert>We couldn’t verify this request. Refresh the page and try again.</Alert>
          </div>
        )}

        {(linkIsUnusable || actionData?.status === 'unavailable') && (
          <p className="mt-4 text-sm text-muted">
            <Link className="font-semibold text-forest underline" to="/forgot-password">
              Request a new reset email
            </Link>
          </p>
        )}

        {tokenIsValid && !linkIsUnusable && (
          <fetcher.Form
            action="/reset-password"
            className="mt-8 space-y-6"
            method="post"
            noValidate
            aria-busy={isSubmitting}
          >
            <input name="csrfToken" type="hidden" value={csrfToken} />
            <input name="token" type="hidden" value={token} />
            <PasswordField
              hint="Use 15–128 characters. A passphrase works well."
              error={actionData?.fieldErrors?.password}
            />
            <Button disabled={isSubmitting} type="submit">
              {isSubmitting ? 'Resetting…' : 'Reset password'}
            </Button>
            <p className="sr-only" role="status" aria-live="polite">
              {isSubmitting ? 'Resetting your password…' : ''}
            </p>
          </fetcher.Form>
        )}

        <Link className="mt-6 inline-flex font-semibold text-forest underline" to="/login">
          Return to sign in
        </Link>
      </AuthCard>
    </AuthPageShell>
  );
}
