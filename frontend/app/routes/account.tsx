import type { Route } from './+types/account';
import { Alert } from '~/components/Alert.js';
import { AuthCard, AuthPageShell } from '~/components/AuthPageShell.js';
import { Button } from '~/components/Button.js';
import { PasswordField } from '~/components/PasswordField.js';
import { loadFrontendConfig } from '~/.server/env.js';
import { clearSessionCookie, loadProtectedUser, readSessionToken } from '~/.server/session.js';
import {
  RequestProtectionError,
  withProtectedSessionFormRequest,
} from '~/.server/request-protection.js';
import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from 'react-router';

interface LogoutResponseData {
  status: 'logged_out';
}

interface ChangePasswordResponseData {
  status: 'changed';
}

interface AccountActionData {
  status: 'blocked' | 'unavailable' | 'limited' | 'invalid';
  fieldErrors?: { currentPassword?: string; newPassword?: string };
}

type AccountOperation = 'logged_out' | 'password_changed';

function isLogoutResponse(value: unknown): value is LogoutResponseData {
  return isStatus(value, 'logged_out');
}

function isChangePasswordResponse(value: unknown): value is ChangePasswordResponseData {
  return isStatus(value, 'changed');
}

function isStatus(value: unknown, status: string): value is { status: string } {
  return (
    typeof value === 'object' && value !== null && 'status' in value && value.status === status
  );
}

function safePolicyMessage(rule: string): string {
  if (rule === 'too_short') return 'Use at least 15 characters.';
  if (rule === 'too_long') return 'Use no more than 128 characters.';
  if (rule === 'incorrect') return 'Check your current password and try again.';
  return 'Check this password and try again.';
}

export async function loader({ request }: Route.LoaderArgs) {
  const config = loadFrontendConfig();
  const result = await loadProtectedUser(request, config);

  if (result.status === 'unavailable') {
    return { status: 'unavailable' as const };
  }

  return {
    status: 'authenticated' as const,
    user: result.user,
    csrfToken: result.csrfToken,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const config = loadFrontendConfig();
  const token = readSessionToken(request.headers.get('cookie'));

  if (!token) {
    const headers = new Headers();
    clearSessionCookie(request, headers, config.frontendOrigin);
    return redirect('/login?returnTo=%2Faccount', { headers });
  }

  try {
    const operation = await withProtectedSessionFormRequest(
      request,
      token,
      config,
      async (form) => {
        const intent = form.get('intent');

        if (intent === 'logout') {
          await requestJson<LogoutResponseData>('/auth/logout', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            signal: request.signal,
            validateData: isLogoutResponse,
          });
          return 'logged_out' satisfies AccountOperation;
        }

        if (intent !== 'change-password') {
          throw new RequestProtectionError(400, 'The form request is invalid.');
        }

        const currentPasswordValue = form.get('currentPassword');
        const newPasswordValue = form.get('newPassword');
        const currentPassword =
          typeof currentPasswordValue === 'string' ? currentPasswordValue : '';
        const newPassword = typeof newPasswordValue === 'string' ? newPasswordValue : '';
        const fieldErrors: NonNullable<AccountActionData['fieldErrors']> = {};

        if (currentPassword.length === 0 || currentPassword.length > 1024) {
          fieldErrors.currentPassword = 'Enter your current password.';
        }

        const codePointCount = [...newPassword.normalize('NFC')].length;
        if (codePointCount < 15) fieldErrors.newPassword = 'Use at least 15 characters.';
        else if (codePointCount > 128) fieldErrors.newPassword = 'Use no more than 128 characters.';

        if (fieldErrors.currentPassword || fieldErrors.newPassword) {
          return { kind: 'invalid' as const, fieldErrors };
        }

        await requestJson<ChangePasswordResponseData>('/auth/change-password', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: { currentPassword, newPassword },
          signal: request.signal,
          validateData: isChangePasswordResponse,
        });

        return 'password_changed' satisfies AccountOperation;
      },
    );

    if (typeof operation !== 'string') {
      return data<AccountActionData>(
        { status: 'invalid', fieldErrors: operation.fieldErrors },
        { status: 400 },
      );
    }

    const headers = new Headers();
    clearSessionCookie(request, headers, config.frontendOrigin);
    return redirect(operation === 'password_changed' ? '/login?passwordChanged=success' : '/', {
      headers,
    });
  } catch (error) {
    if (
      request.signal.aborted ||
      (error instanceof ApiRequestError && error.kind === 'cancelled')
    ) {
      throw error;
    }

    if (error instanceof RequestProtectionError) {
      return data<AccountActionData>({ status: 'blocked' }, { status: error.status });
    }

    if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 401) {
      const headers = new Headers();
      clearSessionCookie(request, headers, config.frontendOrigin);
      return redirect('/login?returnTo=%2Faccount', { headers });
    }

    if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 429) {
      return data<AccountActionData>({ status: 'limited' }, { status: 429 });
    }

    if (
      error instanceof ApiRequestError &&
      error.kind === 'http' &&
      error.status === 400 &&
      error.errorCode === 'VALIDATION_ERROR'
    ) {
      const fields: NonNullable<AccountActionData['fieldErrors']> = {};
      for (const detail of error.details ?? []) {
        if (detail.field === 'currentPassword' || detail.field === 'newPassword') {
          fields[detail.field] = safePolicyMessage(detail.rule);
        }
      }
      return data<AccountActionData>({ status: 'invalid', fieldErrors: fields }, { status: 400 });
    }

    return data<AccountActionData>({ status: 'unavailable' }, { status: 503 });
  }
}

export default function AccountPage() {
  const page = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as AccountActionData | undefined;
  const isSubmitting = useNavigation().state === 'submitting';

  return (
    <AuthPageShell>
      <AuthCard>
        {page.status === 'unavailable' ? (
          <>
            <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
              Account temporarily unavailable
            </h1>
            <p className="mt-3 leading-7 text-muted">
              We couldn’t check your session. Refresh this page to try again.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">Your account</h1>
            <p className="mt-3 leading-7 text-muted">{page.user.email}</p>

            {actionData?.status === 'blocked' && (
              <div className="mt-6">
                <Alert>We couldn’t verify this request. Refresh the page and try again.</Alert>
              </div>
            )}
            {actionData?.status === 'unavailable' && (
              <div className="mt-6">
                <Alert>
                  Password change or sign-out is temporarily unavailable. Please try again.
                </Alert>
              </div>
            )}
            {actionData?.status === 'limited' && (
              <div className="mt-6">
                <Alert>Too many attempts. Wait a little while and try again.</Alert>
              </div>
            )}

            <h2 className="mt-8 text-xl font-semibold text-ink">Change password</h2>
            <Form className="mt-4 space-y-5" method="post" noValidate aria-busy={isSubmitting}>
              <input name="csrfToken" type="hidden" value={page.csrfToken} />
              <input name="intent" type="hidden" value="change-password" />
              <PasswordField
                id="currentPassword"
                name="currentPassword"
                label="Current password"
                autoComplete="current-password"
                hint="Enter your current password."
                error={actionData?.fieldErrors?.currentPassword}
              />
              <PasswordField
                id="newPassword"
                name="newPassword"
                label="New password"
                autoComplete="new-password"
                hint="Use 15–128 characters. A passphrase works well."
                error={actionData?.fieldErrors?.newPassword}
              />
              <Button disabled={isSubmitting} type="submit">
                {isSubmitting ? 'Changing password…' : 'Change password'}
              </Button>
              <p className="sr-only" role="status" aria-live="polite">
                {isSubmitting ? 'Changing password…' : ''}
              </p>
            </Form>

            <Form className="mt-6" method="post" aria-busy={isSubmitting}>
              <input name="csrfToken" type="hidden" value={page.csrfToken} />
              <input name="intent" type="hidden" value="logout" />
              <Button disabled={isSubmitting} type="submit">
                {isSubmitting ? 'Submitting…' : 'Sign out'}
              </Button>
            </Form>
          </>
        )}
        <Link className="mt-6 inline-flex font-semibold text-forest underline" to="/">
          Return home
        </Link>
      </AuthCard>
    </AuthPageShell>
  );
}
