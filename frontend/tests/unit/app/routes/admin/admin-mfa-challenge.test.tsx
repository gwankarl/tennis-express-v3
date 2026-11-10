import type { ComponentType } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import AdminMfaChallengePage from '~/routes/admin/mfa-challenge.js';

function renderChallengePage(action: () => unknown) {
  const Component = AdminMfaChallengePage as ComponentType;
  const router = createMemoryRouter(
    [
      {
        path: '/admin/mfa/challenge',
        loader: () => ({
          status: 'authenticated',
          csrfToken: 'test-session-csrf',
          hasChallenge: false,
          returnTo: '/account',
        }),
        action,
        Component,
      },
    ],
    { initialEntries: ['/admin/mfa/challenge'] },
  );

  render(<RouterProvider router={router} />);
  return router;
}

describe('administrator MFA challenge screen', () => {
  it('moves from password entry to the authenticator code step', async () => {
    renderChallengePage(() => ({ status: 'challenge', returnTo: '/account' }));

    fireEvent.change(await screen.findByLabelText('Current password'), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByLabelText('Six-digit authenticator code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify and continue' })).toBeInTheDocument();
  });

  it('shows safe invalid-code feedback after submitting the password step', async () => {
    renderChallengePage(() => ({
      status: 'invalid',
      step: 'confirm',
      returnTo: '/account',
    }));

    fireEvent.change(await screen.findByLabelText('Current password'), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter the current six-digit code from your authenticator.',
    );
    expect(await screen.findByLabelText('Six-digit authenticator code')).toBeInTheDocument();
  });

  it('shows a temporary-failure message after submitting', async () => {
    renderChallengePage(() => ({
      status: 'unavailable',
      step: 'start',
      returnTo: '/account',
    }));

    fireEvent.change(await screen.findByLabelText('Current password'), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Administrator verification is temporarily unavailable.',
    );
  });

  it('keeps the password form when starting a challenge is rate limited', async () => {
    renderChallengePage(() => ({
      status: 'limited',
      step: 'start',
      returnTo: '/account',
    }));

    fireEvent.change(await screen.findByLabelText('Current password'), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Wait 15 minutes before trying again.',
    );
    expect(await screen.findByLabelText('Current password')).toBeInTheDocument();
    expect(screen.queryByLabelText('Six-digit authenticator code')).not.toBeInTheDocument();
  });

  it('keeps the authenticator form when confirming a challenge is rate limited', async () => {
    renderChallengePage(() => ({
      status: 'limited',
      step: 'confirm',
      returnTo: '/account',
    }));

    fireEvent.change(await screen.findByLabelText('Current password'), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Wait 15 minutes before trying again.',
    );
    expect(await screen.findByLabelText('Six-digit authenticator code')).toBeInTheDocument();
  });

  it('announces pending password verification accessibly', async () => {
    let finishAction!: (result: { status: 'challenge'; returnTo: string }) => void;
    renderChallengePage(
      () =>
        new Promise<{ status: 'challenge'; returnTo: string }>((resolve) => {
          finishAction = resolve;
        }),
    );

    fireEvent.change(await screen.findByLabelText('Current password'), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Checking administrator credentials…',
    );
    finishAction({ status: 'challenge', returnTo: '/account' });
    expect(await screen.findByLabelText('Six-digit authenticator code')).toBeInTheDocument();
  });
});
