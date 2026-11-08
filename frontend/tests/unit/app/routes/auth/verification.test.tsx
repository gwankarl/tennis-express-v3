import type { ComponentType } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/.server/env.js', () => ({ loadFrontendConfig: vi.fn() }));
vi.mock('~/.server/api-client.js', () => ({
  ApiRequestError: class ApiRequestError extends Error {},
  requestJson: vi.fn(),
}));
vi.mock('~/.server/auth/request-protection.js', () => ({
  issueCsrfToken: vi.fn(),
  RequestProtectionError: class RequestProtectionError extends Error {},
  withProtectedFormRequest: vi.fn(),
}));

import VerifyEmailPage from '~/routes/auth/verify-email.js';
import ResendVerificationPage from '~/routes/auth/resend-verification.js';

const token = 'A'.repeat(43);

function renderPage(path: string, Component: ComponentType, action: () => unknown) {
  const router = createMemoryRouter(
    [
      {
        path: path.split('?')[0],
        loader: () => ({ csrfToken: 'test-csrf-token' }),
        action,
        Component,
      },
    ],
    { initialEntries: [path] },
  );

  render(<RouterProvider router={router} />);
  return router;
}

describe('verification screens', () => {
  it('shows verification success after a protected form submission', async () => {
    renderPage(`/verify-email?token=${token}`, VerifyEmailPage, () => ({ status: 'verified' }));

    fireEvent.change(await screen.findByLabelText('Password'), {
      target: { value: 'signup passphrase' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify email' }));

    expect(await screen.findByRole('heading', { name: 'Email verified' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue to Tennis Xpress' })).toHaveAttribute(
      'href',
      '/',
    );
  });

  it('offers a resend path for rejected credentials or an unusable link', async () => {
    renderPage(`/verify-email?token=${token}`, VerifyEmailPage, () => ({ status: 'rejected' }));

    fireEvent.change(await screen.findByLabelText('Password'), {
      target: { value: 'wrong password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify email' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We couldn’t verify this link and password.',
    );
    expect(screen.getByRole('link', { name: 'Request a new verification link' })).toHaveAttribute(
      'href',
      '/resend-verification',
    );
  });

  it('shows the same generic confirmation for an accepted resend', async () => {
    renderPage('/resend-verification', ResendVerificationPage, () => ({ status: 'accepted' }));

    fireEvent.change(await screen.findByLabelText('Email address'), {
      target: { value: 'player@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send verification link' }));

    expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
    expect(
      screen.getByText('If an account can receive a verification email, we’ll send a link.'),
    ).toBeInTheDocument();
  });

  it('announces pending verification accessibly while the action is running', async () => {
    let finishAction!: (result: { status: 'verified' }) => void;
    const pendingAction = () =>
      new Promise<{ status: 'verified' }>((resolve) => {
        finishAction = resolve;
      });

    renderPage(`/verify-email?token=${token}`, VerifyEmailPage, pendingAction);
    fireEvent.change(await screen.findByLabelText('Password'), {
      target: { value: 'signup passphrase' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify email' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Verifying your email…');

    await act(async () => finishAction({ status: 'verified' }));
    expect(await screen.findByRole('heading', { name: 'Email verified' })).toBeInTheDocument();
  });
});
