import { Alert } from '~/components/Alert.js';
import { Button } from '~/components/Button.js';
import { AuthCard, AuthPageShell } from '~/features/auth/AuthLayout.js';
import { Link, useFetcher, useLocation } from 'react-router';

interface RestrictedAccountStateProps {
  csrfToken: string;
}

interface TemporaryAccessStateProps {
  title: string;
  message: string;
}

interface SellerUnavailableStateProps {
  buyerAvailable: boolean;
}

export function RestrictedAccountState({ csrfToken }: RestrictedAccountStateProps) {
  const signOutFetcher = useFetcher<{ status: 'blocked' | 'unavailable' }>();
  const isSigningOut = signOutFetcher.state !== 'idle';

  return (
    <AuthPageShell>
      <AuthCard>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
          Account access restricted
        </h1>
        <p className="mt-3 leading-7 text-muted">
          We can’t provide access to this account right now. Contact support if you need help.
        </p>

        <a
          className="mt-6 inline-flex font-semibold text-forest underline"
          href="mailto:support@example.com"
        >
          Contact support
        </a>

        {signOutFetcher.data?.status === 'blocked' && (
          <div className="mt-6">
            <Alert>We couldn’t verify this request. Refresh and try signing out again.</Alert>
          </div>
        )}
        {signOutFetcher.data?.status === 'unavailable' && (
          <div className="mt-6">
            <Alert>Sign-out is temporarily unavailable. Please try again.</Alert>
          </div>
        )}

        <signOutFetcher.Form
          action="/sign-out"
          className="mt-6"
          method="post"
          aria-busy={isSigningOut}
        >
          <input name="csrfToken" type="hidden" value={csrfToken} />
          <Button disabled={isSigningOut} type="submit">
            {isSigningOut ? 'Signing out…' : 'Sign out'}
          </Button>
          <p className="sr-only" role="status" aria-live="polite">
            {isSigningOut ? 'Signing out…' : ''}
          </p>
        </signOutFetcher.Form>
      </AuthCard>
    </AuthPageShell>
  );
}

export function TemporaryAccessState({ title, message }: TemporaryAccessStateProps) {
  const location = useLocation();
  const requestedPath = `${location.pathname}${location.search}`;

  return (
    <AuthPageShell>
      <AuthCard>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mt-3 leading-7 text-muted">{message}</p>
        <Link
          className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-forest px-5 font-semibold text-white"
          reloadDocument
          to={requestedPath}
        >
          Try again
        </Link>
      </AuthCard>
    </AuthPageShell>
  );
}

export function SellerUnavailableState({ buyerAvailable }: SellerUnavailableStateProps) {
  return (
    <AuthPageShell>
      <AuthCard>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
          Seller workspace unavailable
        </h1>
        <p className="mt-3 leading-7 text-muted">
          Seller tools are unavailable for this account right now.
        </p>
        {buyerAvailable && (
          <Link
            className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-forest px-5 font-semibold text-white"
            to="/account"
          >
            Go to Buyer workspace
          </Link>
        )}
      </AuthCard>
    </AuthPageShell>
  );
}
