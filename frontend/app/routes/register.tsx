import type { Route } from './+types/register';
import { Alert } from '~/components/Alert.js';
import { AuthCard, AuthPageShell } from '~/components/AuthPageShell.js';
import { Button } from '~/components/Button.js';
import { FormField } from '~/components/FormField.js';
import { PasswordField } from '~/components/PasswordField.js';
import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { loadFrontendConfig } from '~/.server/env.js';
import {
  issueCsrfToken,
  RequestProtectionError,
  withProtectedFormRequest,
} from '~/.server/request-protection.js';
import { data, Form, useActionData, useLoaderData, useNavigation } from 'react-router';

interface RegistrationResponseData {
  status: 'accepted';
}

interface RegistrationActionData {
  status: 'accepted' | 'invalid' | 'unavailable' | 'blocked';
  email?: string;
  fieldErrors?: {
    email?: string;
    password?: string;
  };
  message?: string;
}

function isRegistrationResponse(value: unknown): value is RegistrationResponseData {
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
      const rawEmail = form.get('email');
      const rawPassword = form.get('password');
      const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';
      const password = typeof rawPassword === 'string' ? rawPassword : '';
      const fieldErrors: NonNullable<RegistrationActionData['fieldErrors']> = {};

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
        fieldErrors.email = 'Enter a valid email address.';
      }

      const passwordLength = [...password.normalize('NFC')].length;

      if (passwordLength < 15 || passwordLength > 128) {
        fieldErrors.password = 'Use 15–128 characters.';
      }

      if (fieldErrors.email || fieldErrors.password) {
        return data<RegistrationActionData>(
          { status: 'invalid', email, fieldErrors },
          { status: 400 },
        );
      }

      try {
        await requestJson<RegistrationResponseData>('/auth/register', {
          method: 'POST',
          body: { email, password },
          signal: request.signal,
          validateData: isRegistrationResponse,
        });

        return { status: 'accepted' } satisfies RegistrationActionData;
      } catch (error) {
        if (
          request.signal.aborted ||
          (error instanceof ApiRequestError && error.kind === 'cancelled')
        ) {
          throw error;
        }

        if (
          error instanceof ApiRequestError &&
          error.errorCode === 'VALIDATION_ERROR' &&
          error.details
        ) {
          const serverFieldErrors = mapValidationDetails(error.details);

          if (serverFieldErrors.email || serverFieldErrors.password) {
            return data<RegistrationActionData>(
              { status: 'invalid', email, fieldErrors: serverFieldErrors },
              { status: 400 },
            );
          }
        }

        return data<RegistrationActionData>({ status: 'unavailable', email }, { status: 503 });
      }
    });
  } catch (error) {
    if (request.signal.aborted) {
      throw error;
    }

    if (error instanceof RequestProtectionError) {
      return data<RegistrationActionData>({ status: 'blocked' }, { status: error.status });
    }

    return data<RegistrationActionData>({ status: 'unavailable' }, { status: 503 });
  }
}

function mapValidationDetails(
  details: NonNullable<ApiRequestError['details']>,
): NonNullable<RegistrationActionData['fieldErrors']> {
  const fieldErrors: NonNullable<RegistrationActionData['fieldErrors']> = {};

  for (const detail of details) {
    const field = detail.field
      .split('/')
      .at(-1)
      ?.replace(/^body\./u, '');

    if (field === 'email') {
      fieldErrors.email = 'Enter a valid email address.';
    } else if (field === 'password') {
      fieldErrors.password = 'Use 15–128 characters.';
    }
  }

  return fieldErrors;
}

export default function RegisterPage() {
  const { csrfToken } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as RegistrationActionData | undefined;
  const navigation = useNavigation();
  const isSubmitting = navigation.state === 'submitting';

  if (actionData?.status === 'accepted') {
    return (
      <AuthPageShell>
        <AuthCard>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">Check your inbox</h1>
          <p className="mt-3 leading-7 text-muted">
            If your signup can continue, we’ll send a verification link.
          </p>
        </AuthCard>
      </AuthPageShell>
    );
  }

  return (
    <AuthPageShell>
      <AuthCard>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">Create your account</h1>
        <p className="mt-2 leading-6 text-muted">
          Join the Tennis Xpress community and get ready to play.
        </p>

        {actionData?.status === 'unavailable' && (
          <div className="mt-6">
            <Alert>We couldn’t create your account right now. Please try again.</Alert>
          </div>
        )}

        {actionData?.status === 'blocked' && (
          <div className="mt-6">
            <Alert>We couldn’t verify this request. Refresh the page and try again.</Alert>
          </div>
        )}

        {actionData?.message && (
          <div className="mt-6">
            <Alert>{actionData.message}</Alert>
          </div>
        )}

        <Form className="mt-8 space-y-6" method="post" noValidate>
          <input name="csrfToken" type="hidden" value={csrfToken} />

          <FormField id="email" label="Email address" error={actionData?.fieldErrors?.email}>
            <input
              aria-describedby={actionData?.fieldErrors?.email ? 'email-error' : undefined}
              aria-invalid={Boolean(actionData?.fieldErrors?.email)}
              autoComplete="email"
              className="min-h-12 w-full rounded-xl border border-stone-300 bg-white px-4 text-ink outline-none transition placeholder:text-stone-400 focus:border-forest focus:ring-2 focus:ring-forest/15"
              defaultValue={actionData?.email ?? ''}
              id="email"
              name="email"
              required
              type="email"
            />
          </FormField>

          <PasswordField error={actionData?.fieldErrors?.password} />

          <Button disabled={isSubmitting} type="submit">
            {isSubmitting ? 'Creating account…' : 'Create account'}
          </Button>
        </Form>
      </AuthCard>
    </AuthPageShell>
  );
}
