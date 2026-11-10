import type { Route } from './+types/sign-out';
import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { loadFrontendConfig } from '~/.server/env.js';
import {
  RequestProtectionError,
  withProtectedSessionFormRequest,
} from '~/.server/auth/request-protection.js';
import { clearSessionCookie, readSessionToken } from '~/.server/auth/session.js';
import { data, redirect } from 'react-router';

interface LogoutResponseData {
  status: 'logged_out';
}

interface SignOutActionData {
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

    if (error instanceof ApiRequestError && error.kind === 'http' && error.status === 401) {
      const headers = new Headers();
      clearSessionCookie(request, headers, config.frontendOrigin);
      return redirect('/login?returnTo=%2Faccount', { headers });
    }

    if (error instanceof RequestProtectionError) {
      return data<SignOutActionData>({ status: 'blocked' }, { status: error.status });
    }

    return data<SignOutActionData>({ status: 'unavailable' }, { status: 503 });
  }
}
