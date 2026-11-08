import type { Route } from './+types/seller';
import { useLoaderData } from 'react-router';
import { AuthCard, AuthPageShell } from '~/features/auth/AuthLayout.js';
import { WorkspaceSwitcher } from '~/features/workspaces/WorkspaceSwitcher.js';
import {
  RestrictedAccountState,
  SellerUnavailableState,
  TemporaryAccessState,
} from '~/features/auth/AccountAccessStates.js';
import { loadFrontendConfig } from '~/.server/env.js';
import { loadWorkspacePage } from '~/.server/auth/workspaces.js';

export async function loader({ request }: Route.LoaderArgs) {
  const config = loadFrontendConfig();
  const page = await loadWorkspacePage(request, config);

  if (page.status === 'authenticated' && !page.availability.availableWorkspaces.seller) {
    return {
      status: 'seller-unavailable' as const,
      buyerAvailable: page.availability.availableWorkspaces.buyer,
    };
  }

  return page;
}

export default function SellerLandingPage() {
  const page = useLoaderData<typeof loader>();

  if (page.status === 'restricted') {
    return <RestrictedAccountState csrfToken={page.csrfToken} />;
  }

  if (page.status === 'unavailable') {
    return (
      <TemporaryAccessState
        title="Seller workspace temporarily unavailable"
        message="We couldn’t check Seller access. Your session is still in place; try again."
      />
    );
  }

  if (page.status === 'seller-unavailable') {
    return <SellerUnavailableState buyerAvailable={page.buyerAvailable} />;
  }

  return (
    <AuthPageShell>
      <AuthCard>
        <WorkspaceSwitcher
          availability={page.availability}
          csrfToken={page.csrfToken}
          current="seller"
          submitting={false}
        />
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">Seller workspace</h1>
        <p className="mt-3 leading-7 text-muted">
          Your Seller workspace is ready. Seller tools will appear here when they are available.
        </p>
      </AuthCard>
    </AuthPageShell>
  );
}
