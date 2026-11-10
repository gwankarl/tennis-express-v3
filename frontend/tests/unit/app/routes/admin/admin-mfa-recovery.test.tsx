import type { ComponentType } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import AdminMfaRecoveryPage from '~/routes/admin/mfa-recovery.js';

function renderRecoveryPage(action: () => unknown) {
  const Component = AdminMfaRecoveryPage as ComponentType;
  const router = createMemoryRouter(
    [
      {
        path: '/admin/mfa/recovery',
        loader: () => ({
          status: 'authenticated',
          csrfToken: 'test-session-csrf',
        }),
        action,
        Component,
      },
    ],
    { initialEntries: ['/admin/mfa/recovery'] },
  );

  render(<RouterProvider router={router} />);
  return router;
}

describe('administrator MFA recovery screen', () => {
  it('shows the hold and requires a fresh sign-in to enroll a replacement factor', async () => {
    const adminHoldUntil = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    renderRecoveryPage(() => ({
      status: 'recovered',
      adminHoldUntil,
      notificationSent: true,
    }));

    fireEvent.change(await screen.findByLabelText('Current password'), {
      target: { value: 'current-password' },
    });
    fireEvent.change(screen.getByLabelText('Unused recovery code'), {
      target: { value: 'AB12CD34-AB12CD34-AB12CD34-AB12CD34' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recover administrator access' }));

    expect(
      await screen.findByRole('heading', { name: 'MFA recovery started' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Administrator access is on hold until/u)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
      'href',
      '/login?returnTo=%2Fadmin%2Fmfa%2Fenrollment',
    );
  });

  it('shows a safe retry message for an unusable recovery code', async () => {
    renderRecoveryPage(() => ({
      status: 'invalid',
      fieldErrors: { recoveryCode: 'That recovery code is invalid or has already been used.' },
    }));

    fireEvent.change(await screen.findByLabelText('Current password'), {
      target: { value: 'current-password' },
    });
    fireEvent.change(screen.getByLabelText('Unused recovery code'), {
      target: { value: 'AB12CD34-AB12CD34-AB12CD34-AB12CD34' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recover administrator access' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Check your password and recovery code, then try again.',
    );
  });
});
