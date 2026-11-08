import type { Route } from './+types/change-password';
import { Alert } from '~/components/Alert.js';
import { AuthCard, AuthPageShell } from '~/features/auth/AuthLayout.js';
import {
  RestrictedAccountState,
  TemporaryAccessState,
} from '~/features/auth/AccountAccessStates.js';
import { Button } from '~/components/Button.js';
import { PasswordField } from '~/components/PasswordField.js';
import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { loadFrontendConfig } from '~/.server/env.js';
import {
  RequestProtectionError,
  withProtectedSessionFormRequest,
} from '~/.server/auth/request-protection.js';
import { clearSessionCookie, loadProtectedUser, readSessionToken } from '~/.server/auth/session.js';
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from 'react-router';

interface ChangePasswordResponseData {
  status: 'changed';
}

interface ChangePasswordActionData {
  status: 'blocked' | 'unavailable' | 'limited' | 'invalid';
  fieldErrors?: { currentPassword?: string; newPassword?: string };
}

function isChangePasswordResponse(value: unknown): value is ChangePasswordResponseData {
  return (
    typeof value === 'object' && value !== null && 'status' in value && value.status === 'changed'
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

  if (result.status === 'restricted') {
    return { status: 'restricted' as const, csrfToken: result.csrfToken };
  }

  return {
    status: 'authenticated' as const,
    csrfToken: result.csrfToken,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const config = loadFrontendConfig();
  const token = readSessionToken(request.headers.get('cookie'));

  if (!token) {
    const headers = new Headers();
    clearSessionCookie(request, headers, config.frontendOrigin);
    return redirect('/login?returnTo=%2Faccount%2Fchange-password', { headers });
  }

  try {
    const result = await withProtectedSessionFormRequest(request, token, config, async (form) => {
      const currentPasswordValue = form.get('currentPassword');
      const newPasswordValue = form.get('newPassword');
      const currentPassword = typeof currentPasswordValue === 'string' ? currentPasswordValue : '';
      const newPassword = typeof newPasswordValue === 'string' ? newPasswordValue : '';
      const fieldErrors: NonNullable<ChangePasswordActionData['fieldErrors']> = {};

      if (currentPassword.length === 0 || currentPassword.length > 1024) {
        fieldErrors.currentPassword = 'Enter your current password.';
      }

      const codePointCount = [...newPassword.normalize('NFC')].length;
      if (codePointCount < 15) {
        fieldErrors.newPassword = 'Use at least 15 characters.';
      } else if (codePointCount > 128) {
        fieldErrors.newPassword = 'Use no more than 128 characters.';
      }

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

      return { kind: 'changed' as const };
    });

    if (result.kind === 'invalid') {
      return data<ChangePasswordActionData>(
        { status: 'invalid', fieldErrors: result.fieldErrors },
        { status: 400 },
      );
    }

    const headers = new Headers();
    clearSessionCookie(request, headers, config.frontendOrigin);
    return redirect('/login?passwordChanged=success', { headers });
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
      error.status === 403 &&
      error.errorCode === 'ACCOUNT_RESTRICTED'
    ) {
      return redirect('/account/change-password');
    }

    if (error instanceof RequestProtectionError) {
      return data<ChangePasswordActionData>({ status: 'blocked' }, { status: error.status });
    }

    if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 401) {
      const headers = new Headers();
      clearSessionCookie(request, headers, config.frontendOrigin);
      return redirect('/login?returnTo=%2Faccount%2Fchange-password', { headers });
    }

    if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 429) {
      return data<ChangePasswordActionData>({ status: 'limited' }, { status: 429 });
    }

    if (
      error instanceof ApiRequestError &&
      error.kind === 'http' &&
      error.status === 400 &&
      error.errorCode === 'VALIDATION_ERROR'
    ) {
      const fieldErrors: NonNullable<ChangePasswordActionData['fieldErrors']> = {};

      for (const detail of error.details ?? []) {
        if (detail.field === 'currentPassword' || detail.field === 'newPassword') {
          fieldErrors[detail.field] = safePolicyMessage(detail.rule);
        }
      }

      return data<ChangePasswordActionData>({ status: 'invalid', fieldErrors }, { status: 400 });
    }

    return data<ChangePasswordActionData>({ status: 'unavailable' }, { status: 503 });
  }
}

export default function ChangePasswordPage() {
  const page = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ChangePasswordActionData | undefined;
  const isSubmitting = useNavigation().state === 'submitting';

  if (page.status === 'restricted') {
    return <RestrictedAccountState csrfToken={page.csrfToken} />;
  }

  if (page.status === 'unavailable') {
    return (
      <TemporaryAccessState
        title="Password settings temporarily unavailable"
        message="We couldn’t check your account. Your session is still in place; try again."
      />
    );
  }

  return (
    <AuthPageShell>
      <AuthCard>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">Change password</h1>

        {actionData?.status === 'blocked' && (
          <div className="mt-6">
            <Alert>We couldn’t verify this request. Refresh the page and try again.</Alert>
          </div>
        )}

        {actionData?.status === 'unavailable' && (
          <div className="mt-6">
            <Alert>Password change is temporarily unavailable. Please try again.</Alert>
          </div>
        )}

        {actionData?.status === 'limited' && (
          <div className="mt-6">
            <Alert>Too many attempts. Wait a little while and try again.</Alert>
          </div>
        )}

        {page.status === 'authenticated' && (
          <Form className="mt-8 space-y-5" method="post" noValidate aria-busy={isSubmitting}>
            <input name="csrfToken" type="hidden" value={page.csrfToken} />
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
        )}

        <Link className="mt-6 inline-flex font-semibold text-forest underline" to="/account">
          Return to account
        </Link>
      </AuthCard>
    </AuthPageShell>
  );
}
