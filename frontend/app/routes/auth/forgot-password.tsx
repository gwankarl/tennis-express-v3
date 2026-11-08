import type { Route } from './+types/forgot-password';
import { Alert } from '~/components/Alert.js';
import { AuthCard, AuthPageShell } from '~/features/auth/AuthLayout.js';
import { Button } from '~/components/Button.js';
import { FormField } from '~/components/FormField.js';
import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { loadFrontendConfig } from '~/.server/env.js';
import {
  issueCsrfToken,
  RequestProtectionError,
  withProtectedFormRequest,
} from '~/.server/auth/request-protection.js';
import { data, Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';

interface ForgotPasswordResponseData {
  status: 'accepted';
}

interface ForgotPasswordActionData {
  status: 'accepted' | 'invalid' | 'unavailable' | 'blocked';
  fieldErrors?: { email?: string };
}

function isForgotPasswordResponse(value: unknown): value is ForgotPasswordResponseData {
  return (
    typeof value === 'object' && value !== null && 'status' in value && value.status === 'accepted'
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
      const value = form.get('email');
      const email = typeof value === 'string' ? value.trim() : '';

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
        return data<ForgotPasswordActionData>(
          { status: 'invalid', fieldErrors: { email: 'Enter a valid email address.' } },
          { status: 400 },
        );
      }

      try {
        await requestJson<ForgotPasswordResponseData>('/auth/forgot-password', {
          method: 'POST',
          body: { email },
          signal: request.signal,
          validateData: isForgotPasswordResponse,
        });

        return { status: 'accepted' } satisfies ForgotPasswordActionData;
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
          error.status === 400 &&
          error.errorCode === 'VALIDATION_ERROR'
        ) {
          return data<ForgotPasswordActionData>(
            { status: 'invalid', fieldErrors: { email: 'Enter a valid email address.' } },
            { status: 400 },
          );
        }

        return data<ForgotPasswordActionData>({ status: 'unavailable' }, { status: 503 });
      }
    });
  } catch (error) {
    if (request.signal.aborted) throw error;

    if (error instanceof RequestProtectionError) {
      return data<ForgotPasswordActionData>({ status: 'blocked' }, { status: error.status });
    }

    return data<ForgotPasswordActionData>({ status: 'unavailable' }, { status: 503 });
  }
}

export default function ForgotPasswordPage() {
  const { csrfToken } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ForgotPasswordActionData | undefined;
  const isSubmitting = useNavigation().state === 'submitting';

  if (actionData?.status === 'accepted') {
    return (
      <AuthPageShell>
        <AuthCard>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">Check your inbox</h1>
          <p className="mt-3 leading-7 text-muted">
            If an account can receive a reset email, we’ll send a link.
          </p>
          <Link className="mt-6 inline-flex font-semibold text-forest underline" to="/login">
            Return to sign in
          </Link>
        </AuthCard>
      </AuthPageShell>
    );
  }

  return (
    <AuthPageShell>
      <AuthCard>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">Reset your password</h1>
        <p className="mt-3 leading-7 text-muted">
          Enter your account email and we’ll send a reset link if an account can receive one.
        </p>

        {actionData?.status === 'unavailable' && (
          <div className="mt-6">
            <Alert>Password recovery is temporarily unavailable. Please try again.</Alert>
          </div>
        )}
        {actionData?.status === 'blocked' && (
          <div className="mt-6">
            <Alert>We couldn’t verify this request. Refresh the page and try again.</Alert>
          </div>
        )}

        <Form className="mt-8 space-y-6" method="post" noValidate aria-busy={isSubmitting}>
          <input name="csrfToken" type="hidden" value={csrfToken} />
          <FormField id="email" label="Email address" error={actionData?.fieldErrors?.email}>
            <input
              aria-describedby={actionData?.fieldErrors?.email ? 'email-error' : undefined}
              aria-invalid={Boolean(actionData?.fieldErrors?.email)}
              autoComplete="email"
              className="min-h-12 w-full rounded-xl border border-stone-300 bg-white px-4 text-ink outline-none focus:border-forest focus:ring-2 focus:ring-forest/15"
              id="email"
              name="email"
              required
              type="email"
            />
          </FormField>

          <Button disabled={isSubmitting} type="submit">
            {isSubmitting ? 'Sending…' : 'Send reset link'}
          </Button>
          <p className="sr-only" role="status" aria-live="polite">
            {isSubmitting ? 'Sending reset link…' : ''}
          </p>
        </Form>

        <Link className="mt-6 inline-flex font-semibold text-forest underline" to="/login">
          Return to sign in
        </Link>
      </AuthCard>
    </AuthPageShell>
  );
}
