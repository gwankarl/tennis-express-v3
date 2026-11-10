import type { Route } from './+types/index';
import { AuthCard, AuthPageShell } from '~/features/auth/AuthLayout.js';
import { RestrictedAccountState } from '~/features/auth/AccountAccessStates.js';
import { WorkspaceSwitcher } from '~/features/workspaces/WorkspaceSwitcher.js';
import { loadFrontendConfig } from '~/.server/env.js';
import { loadWorkspacePage } from '~/.server/auth/workspaces.js';
import { redirect, useLoaderData } from 'react-router';

export async function loader({ request }: Route.LoaderArgs) {
  const config = loadFrontendConfig();
  const page = await loadWorkspacePage(request, config);

  if (page.status !== 'authenticated') {
    return page;
  }

  if (page.availability.adminEntryState === 'unavailable') {
    throw redirect('/account');
  }

  if (page.availability.adminEntryState === 'mfa_required') {
    const mfaPath =
      page.availability.adminMfaFactorState === 'active'
        ? '/admin/mfa/challenge'
        : '/admin/mfa/enrollment';

    throw redirect(`${mfaPath}?returnTo=${encodeURIComponent('/admin')}`);
  }

  return page;
}

export default function AdminWorkspacePage() {
  const page = useLoaderData<typeof loader>();

  if (page.status === 'restricted') {
    return <RestrictedAccountState csrfToken={page.csrfToken} />;
  }

  if (page.status === 'unavailable') {
    return (
      <AuthPageShell>
        <AuthCard>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">
            Admin workspace temporarily unavailable
          </h1>
          <p className="mt-3 leading-7 text-muted">
            We couldn’t check administrator access. Your session is still in place; try again.
          </p>
          <a
            className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-forest px-5 font-semibold text-white"
            href="/admin"
          >
            Try again
          </a>
        </AuthCard>
      </AuthPageShell>
    );
  }

  return (
    <AuthPageShell>
      <AuthCard>
        <WorkspaceSwitcher
          availability={page.availability}
          csrfToken={page.csrfToken}
          current="admin"
          submitting={false}
        />
        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-ink">Admin workspace</h1>
        <p className="mt-3 leading-7 text-muted">
          Your administrator session is verified. Administrative tools will appear here.
        </p>
      </AuthCard>
    </AuthPageShell>
  );
}
