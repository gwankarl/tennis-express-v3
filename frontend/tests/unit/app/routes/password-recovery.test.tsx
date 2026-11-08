import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/.server/env.js', () => ({ loadFrontendConfig: vi.fn() }));
vi.mock('~/.server/api-client.js', () => ({
  ApiRequestError: class ApiRequestError extends Error {},
  requestJson: vi.fn(),
}));
vi.mock('~/.server/request-protection.js', () => ({
  issueCsrfToken: vi.fn(),
  RequestProtectionError: class RequestProtectionError extends Error {},
  withProtectedFormRequest: vi.fn(),
}));

import ForgotPasswordPage from '~/routes/forgot-password.js';
import ResetPasswordPage from '~/routes/reset-password.js';

const token = 'R'.repeat(43);

function renderForgot(action: () => unknown = () => undefined) {
  const router = createMemoryRouter(
    [
      {
        path: '/forgot-password',
        loader: () => ({ csrfToken: 'test-csrf' }),
        action,
        Component: ForgotPasswordPage,
      },
    ],
    { initialEntries: ['/forgot-password'] },
  );

  render(<RouterProvider router={router} />);
  return router;
}

function renderReset(action: () => unknown = () => undefined) {
  const router = createMemoryRouter(
    [
      {
        path: '/reset-password',
        loader: () => ({ csrfToken: 'test-csrf' }),
        action,
        Component: ResetPasswordPage,
      },
    ],
    { initialEntries: [`/reset-password?token=${token}`] },
  );

  render(<RouterProvider router={router} />);
  return router;
}

describe('password recovery screens', () => {
  it('shows the same inbox confirmation after an accepted recovery request', async () => {
    renderForgot(() => ({ status: 'accepted' }));

    fireEvent.change(await screen.findByLabelText('Email address'), {
      target: { value: 'player@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
    expect(
      screen.getByText('If an account can receive a reset email, we’ll send a link.'),
    ).toBeInTheDocument();
  });

  it('announces pending recovery accessibly', async () => {
    let finish!: (value: unknown) => void;
    renderForgot(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Sending reset link…');

    await act(async () => finish({ status: 'accepted' }));
  });

  it('shows the password form on link open and offers a new email for an unusable link', async () => {
    renderReset(() => ({ status: 'unusable' }));

    expect(
      await screen.findByRole('heading', { name: 'Choose a new password' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getAllByText('Use 15–128 characters. A passphrase works well.')).toHaveLength(2);

    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'a safe replacement passphrase' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This reset link is invalid, expired, or already used.',
    );
    expect(screen.getByRole('link', { name: 'Request a new reset email' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });

  it('does not display the reset form for a malformed link', async () => {
    const router = createMemoryRouter(
      [
        {
          path: '/reset-password',
          loader: () => ({ csrfToken: 'test-csrf' }),
          Component: ResetPasswordPage,
        },
      ],
      { initialEntries: ['/reset-password?token=invalid'] },
    );
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This reset link is invalid, expired, or already used.',
    );
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Request a new reset email' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });
});
