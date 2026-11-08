import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/.server/env.js', () => ({
  loadFrontendConfig: vi.fn(),
}));

vi.mock('~/.server/api-client.js', () => ({
  ApiRequestError: class ApiRequestError extends Error {},
  requestJson: vi.fn(),
}));

vi.mock('~/.server/request-protection.js', () => ({
  issueCsrfToken: vi.fn(),
  RequestProtectionError: class RequestProtectionError extends Error {},
  withProtectedFormRequest: vi.fn(),
}));

import RegisterPage from '~/routes/register.js';

function renderRegistration(action: () => unknown = () => undefined) {
  const router = createMemoryRouter(
    [
      {
        path: '/register',
        loader: () => ({ csrfToken: 'test-token' }),
        action,
        HydrateFallback: () => <p>Loading registration page</p>,
        Component: RegisterPage,
      },
    ],
    { initialEntries: ['/register'] },
  );

  render(<RouterProvider router={router} />);
  return router;
}

describe('registration page', () => {
  it('shows the labeled form, password hint, home link, and show-password control', async () => {
    renderRegistration();

    expect(
      await screen.findByRole('heading', { name: 'Create your account' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByText('Use 15–128 characters. A passphrase works well.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /tennis xpress/i })).toHaveAttribute('href', '/');

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('shows the same inbox confirmation after an accepted action', async () => {
    renderRegistration(() => ({ status: 'accepted' }));

    await screen.findByRole('heading', { name: 'Create your account' });

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'player@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'a safe tennis passphrase' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
    expect(
      screen.getByText('If your signup can continue, we’ll send a verification link.'),
    ).toBeInTheDocument();
  });
});
