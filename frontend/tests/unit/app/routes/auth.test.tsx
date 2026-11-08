import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/.server/env.js', () => ({ loadFrontendConfig: vi.fn() }));
vi.mock('~/.server/api-client.js', () => ({
  ApiRequestError: class ApiRequestError extends Error {},
  requestJson: vi.fn(),
}));
vi.mock('~/.server/request-protection.js', () => ({
  clearAnonymousCsrfCookie: vi.fn(),
  issueCsrfToken: vi.fn(),
  issueSessionCsrfToken: vi.fn(),
  RequestProtectionError: class RequestProtectionError extends Error {},
  withProtectedFormRequest: vi.fn(),
  withProtectedSessionFormRequest: vi.fn(),
}));
vi.mock('~/.server/session.js', () => ({
  appendSessionCookie: vi.fn(),
  clearSessionCookie: vi.fn(),
  loadProtectedUser: vi.fn(),
  readSessionToken: vi.fn(),
  safeReturnTo: vi.fn((value: string | null | undefined) => value ?? '/account'),
}));

import LoginPage from '~/routes/login.js';
import AccountPage from '~/routes/account.js';

function renderLogin(action: () => unknown = () => undefined) {
  const router = createMemoryRouter(
    [
      {
        path: '/login',
        loader: () => ({ csrfToken: 'csrf-test', returnTo: '/account' }),
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

describe('sign-in and account UI', () => {
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

    expect(await screen.findByRole('alert')).toHaveTextContent('Those sign-in details didn’t match');
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
    expect(await screen.findByRole('status')).toHaveTextContent('Signing in…');
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();

    await act(async () => finish({ status: 'invalid' }));
  });

  it('shows a service-unavailable message on sign-in failure', async () => {
    renderLogin(() => ({ status: 'unavailable' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in is temporarily unavailable');
  });

  it('shows only the current account email and a sign-out form', async () => {
    renderAccount({
      status: 'authenticated',
      user: { id: '7ad9dc2c-308e-4a1a-8c45-a9e9e3e7b5dc', email: 'player@example.test' },
      csrfToken: 'csrf-test',
    });

    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeInTheDocument();
    expect(screen.getByText('player@example.test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('shows a retry message instead of treating an API outage as sign-out', async () => {
    renderAccount({ status: 'unavailable' });
    expect(
      await screen.findByRole('heading', { name: 'Account temporarily unavailable' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/refresh this page to try again/i)).toBeInTheDocument();
  });
});
