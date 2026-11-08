import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/.server/env.js', () => ({ loadFrontendConfig: vi.fn() }));
vi.mock('~/.server/api-client.js', () => ({
  ApiRequestError: class ApiRequestError extends Error {},
  requestJson: vi.fn(),
}));
vi.mock('~/.server/auth/request-protection.js', () => ({
  clearAnonymousCsrfCookie: vi.fn(),
  issueCsrfToken: vi.fn(),
  issueSessionCsrfToken: vi.fn(),
  RequestProtectionError: class RequestProtectionError extends Error {},
  withProtectedFormRequest: vi.fn(),
  withProtectedSessionFormRequest: vi.fn(),
}));
vi.mock('~/.server/auth/session.js', () => ({
  appendSessionCookie: vi.fn(),
  clearSessionCookie: vi.fn(),
  loadProtectedUser: vi.fn(),
  readSessionToken: vi.fn(),
  safeReturnTo: vi.fn((value: string | null | undefined) => value ?? '/account'),
}));

import LoginPage from '~/routes/auth/login.js';
import AccountPage from '~/routes/account/index.js';
import ChangePasswordPage from '~/routes/account/change-password.js';

function renderLogin(
  action: () => unknown = () => undefined,
  options: { passwordChanged?: boolean } = {},
) {
  const router = createMemoryRouter(
    [
      {
        path: '/login',
        loader: () => ({
          csrfToken: 'csrf-test',
          returnTo: '/account',
          passwordReset: false,
          passwordChanged: options.passwordChanged ?? false,
        }),
        action,
        Component: LoginPage,
      },
    ],
    { initialEntries: ['/login'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

function renderAccount(loaderData: Record<string, unknown>) {
  const router = createMemoryRouter(
    [
      {
        path: '/account',
        loader: () => loaderData,
        Component: AccountPage,
      },
    ],
    { initialEntries: ['/account'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

function renderChangePassword(loaderData: Record<string, unknown>) {
  const router = createMemoryRouter(
    [
      {
        path: '/account/change-password',
        loader: () => loaderData,
        Component: ChangePasswordPage,
      },
    ],
    { initialEntries: ['/account/change-password'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('authentication and account UI', () => {
  it('shows the password-change confirmation on sign-in', async () => {
    renderLogin(undefined, { passwordChanged: true });
    expect(
      await screen.findByText('Your password has been changed. Sign in with your new password.'),
    ).toHaveAttribute('role', 'status');
  });

  it('renders labeled sign-in fields and a safe invalid-credentials alert', async () => {
    renderLogin(() => ({ status: 'invalid' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'player@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'private password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Those sign-in details didn’t match',
    );
    expect(screen.queryByText('private password')).not.toBeInTheDocument();
  });

  it('shows accessible pending feedback while sign-in is submitting', async () => {
    let finish!: (value: unknown) => void;
    renderLogin(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Signing in');
    expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled();

    await act(async () => finish({ status: 'invalid' }));
  });

  it('shows a service-unavailable message on sign-in failure', async () => {
    renderLogin(() => ({ status: 'unavailable' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sign-in is temporarily unavailable',
    );
  });

  it('shows the current account email, change-password link, and sign-out form', async () => {
    renderAccount({
      status: 'authenticated',
      user: { id: '7ad9dc2c-308e-4a1a-8c45-a9e9e3e7b5dc', email: 'player@example.test' },
      csrfToken: 'csrf-test',
      signOutMessage: null,
    });

    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeInTheDocument();
    expect(screen.getByText('player@example.test')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit profile' })).toHaveAttribute(
      'href',
      '/account/profile',
    );
    expect(screen.getByRole('link', { name: 'Change password' })).toHaveAttribute(
      'href',
      '/account/change-password',
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('renders labeled password fields on the change-password page', async () => {
    renderChangePassword({ status: 'authenticated', csrfToken: 'csrf-test' });

    expect(await screen.findByRole('heading', { name: 'Change password' })).toBeInTheDocument();
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
    expect(
      screen.getByText(/Use 15.*128 characters\. A passphrase works well\./),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change password' })).toBeInTheDocument();
  });

  it('shows an unavailable message instead of treating an API outage as sign-out', async () => {
    renderAccount({ status: 'unavailable' });
    expect(
      await screen.findByRole('heading', { name: 'Account temporarily unavailable' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/your session is still in place/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/account');
  });
});
