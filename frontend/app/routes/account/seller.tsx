import type { Route } from './+types/seller';
import { redirect, useLoaderData } from 'react-router';
import { AuthCard, AuthPageShell } from '~/features/auth/AuthLayout.js';
import { WorkspaceSwitcher } from '~/features/workspaces/WorkspaceSwitcher.js';
import { loadFrontendConfig } from '~/.server/env.js';
import { loadWorkspacePage } from '~/.server/auth/workspaces.js';

export async function loader({ request }: Route.LoaderArgs) {
  const config = loadFrontendConfig();
  const page = await loadWorkspacePage(request, config);

  if (page.status === 'authenticated' && !page.availability.availableWorkspaces.seller) {
    if (page.availability.availableWorkspaces.buyer) {
      throw redirect('/account');
    }

    return { status: 'unavailable' as const };
  }

  return page;
}

export default function SellerLandingPage() {
  const page = useLoaderData<typeof loader>();

  return (
    <AuthPageShell>
      <AuthCard>
        {page.status === 'unavailable' ? (
          <>
            <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
              Seller workspace unavailable
            </h1>
            <p className="mt-3 leading-7 text-muted">
              We couldn’t confirm Seller access. Please refresh and try again.
            </p>
          </>
        ) : (
          <>
            <WorkspaceSwitcher
              availability={page.availability}
              csrfToken={page.csrfToken}
              current="seller"
              submitting={false}
            />
            <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
              Seller workspace
            </h1>
            <p className="mt-3 leading-7 text-muted">
              Your Seller workspace is ready. Seller tools will appear here when they are available.
            </p>
          </>
        )}
      </AuthCard>
    </AuthPageShell>
  );
}
