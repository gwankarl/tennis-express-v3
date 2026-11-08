import type { Route } from './+types/layout';
import { Alert } from '~/components/Alert.js';
import {
  readWorkspacePreference,
  setWorkspacePreferenceCookie,
} from '~/.server/auth/workspace-preference.js';
import { WorkspaceSwitcher } from '~/features/workspaces/WorkspaceSwitcher.js';
import { loadFrontendConfig } from '~/.server/env.js';
import {
  fetchWorkspaceAvailability,
  isCancelledWorkspaceRequest,
  isExpiredWorkspaceSession,
  loadWorkspacePage,
} from '~/.server/auth/workspaces.js';
import { clearSessionCookie, isCurrentUser, readSessionToken } from '~/.server/auth/session.js';
import {
  RequestProtectionError,
  withProtectedSessionFormRequest,
} from '~/.server/auth/request-protection.js';
import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { data, Outlet, redirect, useActionData, useLoaderData, useNavigation } from 'react-router';

type SwitchActionData = {
  status: 'invalid' | 'blocked' | 'limited' | 'unavailable';
};

export async function loader({ request }: Route.LoaderArgs) {
  const config = loadFrontendConfig();
  const page = await loadWorkspacePage(request, config);

  if (page.status === 'authenticated' && new URL(request.url).pathname === '/account') {
    const preference = readWorkspacePreference(
      request.headers.get('cookie'),
      page.user.id,
      config.csrfSecret,
    );

    if (preference === 'seller' && page.availability.availableWorkspaces.seller) {
      throw redirect('/seller');
    }
  }

  return page;
}

export async function action({ request }: Route.ActionArgs) {
  const config = loadFrontendConfig();
  const sessionToken = readSessionToken(request.headers.get('cookie'));

  if (!sessionToken) {
    const headers = new Headers();
    if (request.headers.get('cookie')?.includes('tx_session=')) {
      clearSessionCookie(request, headers, config.frontendOrigin);
    }
    return redirect('/login?returnTo=%2Faccount', { headers });
  }

  try {
    return await withProtectedSessionFormRequest(request, sessionToken, config, async (form) => {
      const choices = form.getAll('workspace');
      const selected = choices[0];

      if (choices.length !== 1 || (selected !== 'buyer' && selected !== 'seller')) {
        return data<SwitchActionData>({ status: 'invalid' }, { status: 400 });
      }

      const user = await requestJson<{ id: string; email: string }>('/auth/me', {
        headers: { authorization: `Bearer ${sessionToken}` },
        signal: request.signal,
        validateData: isCurrentUser,
      });

      const availability = await fetchWorkspaceAvailability(sessionToken, request.signal);

      if (selected === 'seller' && !availability.availableWorkspaces.seller) {
        return redirect('/account');
      }

      const headers = new Headers();
      setWorkspacePreferenceCookie(request, headers, user.id, selected, config);

      return redirect(selected === 'seller' ? '/seller' : '/account', { headers });
    });
  } catch (error) {
    if (isCancelledWorkspaceRequest(request, error)) throw error;

    if (error instanceof RequestProtectionError) {
      return data<SwitchActionData>({ status: 'blocked' }, { status: error.status });
    }

    if (isExpiredWorkspaceSession(error)) {
      const headers = new Headers();
      clearSessionCookie(request, headers, config.frontendOrigin);
      return redirect('/login?returnTo=%2Faccount', { headers });
    }

    if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 429) {
      return data<SwitchActionData>({ status: 'limited' }, { status: 429 });
    }

    return data<SwitchActionData>({ status: 'unavailable' }, { status: 503 });
  }
}

export default function AccountLayout() {
  const page = useLoaderData<typeof loader>();
  const actionResult = useActionData<typeof action>();
  const isSubmitting = useNavigation().state === 'submitting';

  return (
    <>
      {page.status === 'authenticated' && (
        <header className="mx-auto w-full max-w-5xl px-4 pt-4 sm:px-6">
          <WorkspaceSwitcher
            availability={page.availability}
            csrfToken={page.csrfToken}
            current="buyer"
            submitting={isSubmitting}
          />
        </header>
      )}

      {actionResult?.status === 'blocked' && (
        <div className="mx-auto mt-4 max-w-5xl px-4 sm:px-6">
          <Alert>We couldn’t verify this request. Refresh the page and try again.</Alert>
        </div>
      )}
      {actionResult?.status === 'limited' && (
        <div className="mx-auto mt-4 max-w-5xl px-4 sm:px-6">
          <Alert>Too many requests. Please wait and try again.</Alert>
        </div>
      )}
      {(actionResult?.status === 'invalid' || actionResult?.status === 'unavailable') && (
        <div className="mx-auto mt-4 max-w-5xl px-4 sm:px-6">
          <Alert>Workspace switching is temporarily unavailable. Please try again.</Alert>
        </div>
      )}

      <Outlet />
    </>
  );
}
