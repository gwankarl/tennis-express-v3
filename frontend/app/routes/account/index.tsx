import type { Route } from './+types/index';
import { Alert } from '~/components/Alert.js';
import { AuthCard, AuthPageShell } from '~/features/auth/AuthLayout.js';
import {
  RestrictedAccountState,
  TemporaryAccessState,
} from '~/features/auth/AccountAccessStates.js';
import { Button } from '~/components/Button.js';
import { loadFrontendConfig } from '~/.server/env.js';
import { loadProtectedUser } from '~/.server/auth/session.js';
import { Link, useFetcher, useLoaderData } from 'react-router';

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
    user: result.user,
    csrfToken: result.csrfToken,
  };
}

export default function AccountPage() {
  const page = useLoaderData<typeof loader>();
  const signOutFetcher = useFetcher<{ status: 'blocked' | 'unavailable' }>();
  const isSigningOut = signOutFetcher.state !== 'idle';

  if (page.status === 'restricted') {
    return <RestrictedAccountState csrfToken={page.csrfToken} />;
  }

  if (page.status === 'unavailable') {
    return (
      <TemporaryAccessState
        title="Account temporarily unavailable"
        message="We couldn’t check your session. Your session is still in place; try again."
      />
    );
  }

  return (
    <AuthPageShell>
      <AuthCard>
        <>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">Your account</h1>
          <p className="mt-3 leading-7 text-muted">{page.user.email}</p>

          {signOutFetcher.data?.status === 'unavailable' && (
            <div className="mt-6">
              <Alert>Sign-out is temporarily unavailable. Please try again.</Alert>
            </div>
          )}

          {signOutFetcher.data?.status === 'blocked' && (
            <div className="mt-6">
              <Alert>We couldn’t verify this request. Refresh the page and try again.</Alert>
            </div>
          )}

          <Link
            className="mt-8 mr-1 inline-flex font-semibold text-forest underline"
            to="/account/profile"
          >
            Edit profile
          </Link>

          <Link
            className="mt-3 inline-flex font-semibold text-forest underline"
            to="/account/change-password"
          >
            Change password
          </Link>

          <signOutFetcher.Form
            action="/sign-out"
            className="mt-6"
            method="post"
            aria-busy={isSigningOut}
          >
            <input name="csrfToken" type="hidden" value={page.csrfToken} />
            <Button disabled={isSigningOut} type="submit">
              {isSigningOut ? 'Signing out…' : 'Sign out'}
            </Button>
            <p className="sr-only" role="status" aria-live="polite">
              {isSigningOut ? 'Signing out…' : ''}
            </p>
          </signOutFetcher.Form>
        </>

        <Link className="mt-6 inline-flex font-semibold text-forest underline" to="/">
          Return home
        </Link>
      </AuthCard>
    </AuthPageShell>
  );
}
