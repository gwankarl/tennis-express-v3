import { useEffect, useState } from 'react';
import type { Route } from './+types/profile';
import { Alert } from '~/components/Alert.js';
import { Button } from '~/components/Button.js';
import { FormField } from '~/components/FormField.js';
import { AuthCard, AuthPageShell } from '~/features/auth/AuthLayout.js';
import {
  RestrictedAccountState,
  TemporaryAccessState,
} from '~/features/auth/AccountAccessStates.js';
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

interface UserProfile {
  id: string;
  displayName: string | null;
  email: string;
  emailVerifiedAt: string;
}

interface ProfileActionData {
  status: 'saved' | 'invalid' | 'blocked' | 'limited' | 'unavailable';
  displayName?: string;
  fieldError?: string;
}

function isUserProfile(value: unknown): value is UserProfile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'displayName' in value &&
    (value.displayName === null ||
      (typeof value.displayName === 'string' && [...value.displayName].length <= 100)) &&
    'email' in value &&
    typeof value.email === 'string' &&
    'emailVerifiedAt' in value &&
    typeof value.emailVerifiedAt === 'string' &&
    Number.isFinite(Date.parse(value.emailVerifiedAt))
  );
}

function isCancelled(request: Request, error: unknown): boolean {
  return request.signal.aborted || (error instanceof ApiRequestError && error.kind === 'cancelled');
}

function isExpiredSession(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.kind === 'http' &&
    error.status === 401 &&
    error.errorCode === 'REQUEST_ERROR'
  );
}

function signInRedirect(request: Request, frontendOrigin: string): Response {
  const headers = new Headers();
  clearSessionCookie(request, headers, frontendOrigin);
  return redirect('/login?returnTo=%2Faccount%2Fprofile', { headers });
}

function safeDisplayNameError(rule: string): string {
  if (rule === 'non_blank' || rule === 'minLength') {
    return 'Enter a display name.';
  }

  if (rule === 'maxLength') {
    return 'Use 100 characters or fewer.';
  }

  return 'Check the display name and try again.';
}

export async function loader({ request }: Route.LoaderArgs) {
  const config = loadFrontendConfig();
  const protectedUser = await loadProtectedUser(request, config);

  if (protectedUser.status === 'unavailable') {
    return { status: 'unavailable' as const };
  }

  if (protectedUser.status === 'restricted') {
    return { status: 'restricted' as const, csrfToken: protectedUser.csrfToken };
  }

  try {
    const profile = await requestJson<UserProfile>('/me/profile', {
      headers: { authorization: `Bearer ${protectedUser.sessionToken}` },
      signal: request.signal,
      validateData: isUserProfile,
    });

    return {
      status: 'authenticated' as const,
      profile,
      csrfToken: protectedUser.csrfToken,
    };
  } catch (error) {
    if (isCancelled(request, error)) {
      throw error;
    }

    if (
      error instanceof ApiRequestError &&
      error.kind === 'http' &&
      error.status === 403 &&
      error.errorCode === 'ACCOUNT_RESTRICTED'
    ) {
      return { status: 'restricted' as const, csrfToken: protectedUser.csrfToken };
    }

    if (isExpiredSession(error)) {
      throw signInRedirect(request, config.frontendOrigin);
    }

    return { status: 'unavailable' as const };
  }
}

export async function action({ request }: Route.ActionArgs) {
  const config = loadFrontendConfig();
  const sessionToken = readSessionToken(request.headers.get('cookie'));

  if (!sessionToken) {
    return signInRedirect(request, config.frontendOrigin);
  }

  let submittedName = '';

  try {
    const result = await withProtectedSessionFormRequest(
      request,
      sessionToken,
      config,
      async (form) => {
        const formValue = form.get('displayName');
        submittedName = typeof formValue === 'string' ? formValue : '';
        const displayName = submittedName.trim();
        const codePointLength = [...displayName].length;

        if (displayName.length === 0) {
          return {
            kind: 'invalid' as const,
            fieldError: 'Enter a display name.',
          };
        }

        if (codePointLength > 100) {
          return {
            kind: 'invalid' as const,
            fieldError: 'Use 100 characters or fewer.',
          };
        }

        const savedProfile = await requestJson<UserProfile>('/me/profile', {
          method: 'PATCH',
          headers: { authorization: `Bearer ${sessionToken}` },
          body: { displayName },
          signal: request.signal,
          validateData: isUserProfile,
        });

        return {
          kind: 'saved' as const,
          displayName: savedProfile.displayName ?? displayName,
        };
      },
    );

    if (result.kind === 'invalid') {
      return data<ProfileActionData>(
        {
          status: 'invalid',
          displayName: submittedName,
          fieldError: result.fieldError,
        },
        { status: 400 },
      );
    }

    return data<ProfileActionData>(
      { status: 'saved', displayName: result.displayName },
      { status: 200 },
    );
  } catch (error) {
    if (isCancelled(request, error)) {
      throw error;
    }

    if (
      error instanceof ApiRequestError &&
      error.kind === 'http' &&
      error.status === 403 &&
      error.errorCode === 'ACCOUNT_RESTRICTED'
    ) {
      return redirect('/account/profile');
    }

    if (error instanceof RequestProtectionError) {
      return data<ProfileActionData>(
        { status: 'blocked', displayName: submittedName },
        { status: error.status },
      );
    }

    if (isExpiredSession(error)) {
      return signInRedirect(request, config.frontendOrigin);
    }

    if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 429) {
      return data<ProfileActionData>(
        { status: 'limited', displayName: submittedName },
        { status: 429 },
      );
    }

    if (
      error instanceof ApiRequestError &&
      error.kind === 'http' &&
      error.status === 400 &&
      error.errorCode === 'VALIDATION_ERROR'
    ) {
      const detail = error.details?.find(
        (item) =>
          item.field === 'displayName' ||
          item.field === '/displayName' ||
          item.field.endsWith('/displayName'),
      );

      return data<ProfileActionData>(
        {
          status: 'invalid',
          displayName: submittedName,
          fieldError: detail
            ? safeDisplayNameError(detail.rule)
            : 'Check the display name and try again.',
        },
        { status: 400 },
      );
    }

    return data<ProfileActionData>(
      { status: 'unavailable', displayName: submittedName },
      { status: 503 },
    );
  }
}

export default function ProfilePage() {
  const page = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ProfileActionData | undefined;
  const isSubmitting = useNavigation().state === 'submitting';
  const actionDisplayName = actionData?.displayName;
  const [displayName, setDisplayName] = useState(
    page.status === 'authenticated' ? (page.profile.displayName ?? '') : '',
  );

  useEffect(() => {
    if (typeof actionDisplayName === 'string') {
      setDisplayName(actionDisplayName);
    }
  }, [actionDisplayName]);

  if (page.status === 'restricted') {
    return <RestrictedAccountState csrfToken={page.csrfToken} />;
  }

  if (page.status === 'unavailable') {
    return (
      <TemporaryAccessState
        title="Profile temporarily unavailable"
        message="We couldn’t load your profile. Your session is still in place; try again."
      />
    );
  }

  return (
    <AuthPageShell>
      <AuthCard>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">Edit profile</h1>

        <>
          <dl className="mt-6 space-y-4 text-sm">
            <div>
              <dt className="font-semibold text-ink">Email</dt>
              <dd className="mt-1 break-all text-muted">{page.profile.email}</dd>
            </div>
            <div>
              <dt className="font-semibold text-ink">Email status</dt>
              <dd className="mt-1 text-muted">Verified</dd>
            </div>
            <div>
              <dt className="font-semibold text-ink">Verified on</dt>
              <dd className="mt-1 text-muted">
                <time dateTime={page.profile.emailVerifiedAt}>
                  {page.profile.emailVerifiedAt.slice(0, 10)}
                </time>
              </dd>
            </div>
          </dl>

          {actionData?.status === 'saved' && (
            <p className="mt-6 text-sm font-semibold text-forest" role="status" aria-live="polite">
              Profile saved.
            </p>
          )}

          {actionData?.status === 'blocked' && (
            <div className="mt-6">
              <Alert>We couldn’t verify this request. Refresh the page and try again.</Alert>
            </div>
          )}

          {actionData?.status === 'limited' && (
            <div className="mt-6">
              <Alert>Too many attempts. Wait a little while and try again.</Alert>
            </div>
          )}

          {actionData?.status === 'unavailable' && (
            <div className="mt-6">
              <Alert>Profile could not be saved. Please try again.</Alert>
            </div>
          )}

          <Form className="mt-8 space-y-5" method="post" noValidate aria-busy={isSubmitting}>
            <input name="csrfToken" type="hidden" value={page.csrfToken} />

            <FormField
              id="displayName"
              label="Display name"
              hint="Choose the name shown on your profile."
              error={actionData?.status === 'invalid' ? actionData.fieldError : undefined}
            >
              <input
                id="displayName"
                name="displayName"
                type="text"
                autoComplete="name"
                required
                maxLength={100}
                value={displayName}
                onChange={(event) => setDisplayName(event.currentTarget.value)}
                aria-invalid={actionData?.status === 'invalid'}
                aria-describedby={[
                  'displayName-hint',
                  actionData?.status === 'invalid' ? 'displayName-error' : undefined,
                ]
                  .filter(Boolean)
                  .join(' ')}
                className="min-h-12 w-full rounded-xl border border-stone-300 bg-white px-4 text-ink outline-none transition placeholder:text-stone-400 focus:border-forest focus:ring-2 focus:ring-forest/15"
              />
            </FormField>

            <Button disabled={isSubmitting} type="submit">
              {isSubmitting ? 'Saving profile…' : 'Save profile'}
            </Button>

            <p className="sr-only" role="status" aria-live="polite">
              {isSubmitting ? 'Saving profile…' : ''}
            </p>
          </Form>

          <Link className="mt-6 inline-flex font-semibold text-forest underline" to="/account">
            Return to account
          </Link>
        </>
      </AuthCard>
    </AuthPageShell>
  );
}
