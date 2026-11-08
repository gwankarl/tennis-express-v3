import type { Route } from './+types/account';
import { Alert } from '~/components/Alert.js';
import { AuthCard, AuthPageShell } from '~/components/AuthPageShell.js';
import { Button } from '~/components/Button.js';
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

interface AccountActionData {
  status: 'blocked' | 'unavailable';
}

function isLogoutResponse(value: unknown): value is LogoutResponseData {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'logged_out'
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  const config = loadFrontendConfig();
  const result = await loadProtectedUser(request, config);

  if (result.status === 'unavailable') {
    return { status: 'unavailable' as const };
  }

  // Do not return result.sessionToken. It remains server-side.
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
    await withProtectedSessionFormRequest(request, token, config, async () => {
      await requestJson<LogoutResponseData>('/auth/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        signal: request.signal,
        validateData: isLogoutResponse,
      });
    });

    const headers = new Headers();
    clearSessionCookie(request, headers, config.frontendOrigin);
    return redirect('/', { headers });
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

    if (
      error instanceof ApiRequestError &&
      error.kind === 'http' &&
      error.status === 401 &&
      error.errorCode === 'REQUEST_ERROR'
    ) {
      const headers = new Headers();
      clearSessionCookie(request, headers, config.frontendOrigin);
      return redirect('/login?returnTo=%2Faccount', { headers });
    }

    // Keep the cookie so the user can retry revocation when the backend returns.
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
                <Alert>Sign-out is temporarily unavailable. Please try again.</Alert>
              </div>
            )}
            <Form className="mt-8" method="post" aria-busy={isSubmitting}>
              <input name="csrfToken" type="hidden" value={page.csrfToken} />
              <Button disabled={isSubmitting} type="submit">
                {isSubmitting ? 'Signing out…' : 'Sign out'}
              </Button>
              <p className="sr-only" role="status" aria-live="polite">
                {isSubmitting ? 'Signing out…' : ''}
              </p>
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
