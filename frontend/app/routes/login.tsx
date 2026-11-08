import type { Route } from './+types/login';
import { Alert } from '~/components/Alert.js';
import { AuthCard, AuthPageShell } from '~/components/AuthPageShell.js';
import { Button } from '~/components/Button.js';
import { FormField } from '~/components/FormField.js';
import { PasswordField } from '~/components/PasswordField.js';
import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { loadFrontendConfig } from '~/.server/env.js';
import { appendSessionCookie, safeReturnTo } from '~/.server/session.js';
import {
  clearAnonymousCsrfCookie,
  issueCsrfToken,
  RequestProtectionError,
  withProtectedFormRequest,
} from '~/.server/request-protection.js';
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from 'react-router';

interface LoginResponseData {
  sessionToken: string;
  tokenType: 'Bearer';
  expiresAt: string;
}

interface LoginActionData {
  status: 'invalid' | 'limited' | 'unavailable' | 'blocked';
  email?: string;
  fieldErrors?: { email?: string; password?: string };
}

function isLoginResponse(value: unknown): value is LoginResponseData {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sessionToken' in value &&
    typeof value.sessionToken === 'string' &&
    /^[A-Za-z0-9_-]{43}$/u.test(value.sessionToken) &&
    'tokenType' in value &&
    value.tokenType === 'Bearer' &&
    'expiresAt' in value &&
    typeof value.expiresAt === 'string' &&
    Number.isFinite(Date.parse(value.expiresAt))
  );
}

export function loader({ request }: Route.LoaderArgs) {
  const config = loadFrontendConfig();
  const headers = new Headers();
  const csrfToken = issueCsrfToken(request, headers, config);
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get('returnTo'));

  const passwordReset = new URL(request.url).searchParams.get('passwordReset') === 'success';
  return data({ csrfToken, returnTo, passwordReset }, { headers });
}

export async function action({ request }: Route.ActionArgs) {
  const config = loadFrontendConfig();

  try {
    return await withProtectedFormRequest(request, config, async (form) => {
      const emailValue = form.get('email');
      const passwordValue = form.get('password');
      const email = typeof emailValue === 'string' ? emailValue.trim() : '';
      const password = typeof passwordValue === 'string' ? passwordValue : '';
      const returnToValue = form.get('returnTo');
      const returnTo = safeReturnTo(typeof returnToValue === 'string' ? returnToValue : undefined);
      const fieldErrors: NonNullable<LoginActionData['fieldErrors']> = {};

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
        fieldErrors.email = 'Enter a valid email address.';
      }

      if (password.length === 0 || password.length > 1024) {
        fieldErrors.password = 'Enter your password.';
      }

      if (fieldErrors.email || fieldErrors.password) {
        return data<LoginActionData>({ status: 'invalid', email, fieldErrors }, { status: 400 });
      }

      try {
        const result = await requestJson<LoginResponseData>('/auth/login', {
          method: 'POST',
          body: { email, password },
          signal: request.signal,
          validateData: isLoginResponse,
        });

        const headers = new Headers();
        appendSessionCookie(request, headers, result.sessionToken, result.expiresAt, config);
        clearAnonymousCsrfCookie(request, headers, config);

        return redirect(returnTo, { headers });
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
          return data<LoginActionData>({ status: 'invalid', email }, { status: 401 });
        }

        if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 429) {
          return data<LoginActionData>({ status: 'limited', email }, { status: 429 });
        }

        return data<LoginActionData>({ status: 'unavailable', email }, { status: 503 });
      }
    });
  } catch (error) {
    if (request.signal.aborted) throw error;

    if (error instanceof RequestProtectionError) {
      return data<LoginActionData>({ status: 'blocked' }, { status: error.status });
    }

    return data<LoginActionData>({ status: 'unavailable' }, { status: 503 });
  }
}

export default function LoginPage() {
  const { csrfToken, returnTo, passwordReset } = useLoaderData<typeof loader>();

  const actionData = useActionData<typeof action>() as LoginActionData | undefined;
  const isSubmitting = useNavigation().state === 'submitting';

  return (
    <AuthPageShell>
      <AuthCard>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">Sign in</h1>
        <p className="mt-2 leading-6 text-muted">Welcome back to Tennis Xpress.</p>

        {passwordReset && (
          <p
            className="mt-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900"
            role="status"
          >
            Your password has been reset. Sign in with your new password.
          </p>
        )}

        {actionData?.status === 'invalid' && (
          <div className="mt-6">
            <Alert>Those sign-in details didn’t match. Check your email and password.</Alert>
          </div>
        )}
        {actionData?.status === 'limited' && (
          <div className="mt-6">
            <Alert>Too many sign-in attempts. Wait a little while and try again.</Alert>
          </div>
        )}
        {actionData?.status === 'unavailable' && (
          <div className="mt-6">
            <Alert>Sign-in is temporarily unavailable. Please try again.</Alert>
          </div>
        )}
        {actionData?.status === 'blocked' && (
          <div className="mt-6">
            <Alert>We couldn’t verify this request. Refresh the page and try again.</Alert>
          </div>
        )}

        <Form className="mt-8 space-y-6" method="post" noValidate aria-busy={isSubmitting}>
          <input name="csrfToken" type="hidden" value={csrfToken} />
          <input name="returnTo" type="hidden" value={returnTo} />

          <FormField id="email" label="Email address" error={actionData?.fieldErrors?.email}>
            <input
              aria-invalid={Boolean(actionData?.fieldErrors?.email)}
              autoComplete="email"
              className="min-h-12 w-full rounded-xl border border-stone-300 bg-white px-4 text-ink outline-none focus:border-forest focus:ring-2 focus:ring-forest/15"
              defaultValue={actionData?.email ?? ''}
              id="email"
              name="email"
              required
              type="email"
            />
          </FormField>

          <PasswordField autoComplete="current-password" hint="Enter your password." />

          <Link
            className="-mt-3 inline-flex text-sm font-semibold text-forest underline"
            to="/forgot-password"
          >
            Forgot password?
          </Link>

          <Button disabled={isSubmitting} type="submit">
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
          <p className="sr-only" role="status" aria-live="polite">
            {isSubmitting ? 'Signing in…' : ''}
          </p>
        </Form>

        <p className="mt-6 text-sm text-muted">
          New to Tennis Xpress?{' '}
          <Link className="font-semibold text-forest underline" to="/register">
            Create an account
          </Link>
        </p>
      </AuthCard>
    </AuthPageShell>
  );
}
