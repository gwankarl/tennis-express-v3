import type { ComponentType } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import AdminMfaEnrollmentPage from '~/routes/admin/mfa-enrollment.js';

const setup = {
  secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  provisioningUri: 'otpauth://totp/Tennis%20Xpress:test?secret=JBSWY3DPEHPK3PXP',
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
};
const recoveryCodes = Array.from(
  { length: 10 },
  (_, index) => `${String(index).padStart(8, 'A')}-BBBBBBBB-CCCCCCCC-DDDDDDDD`,
);

function renderEnrollmentPage(action: () => unknown) {
  const Component = AdminMfaEnrollmentPage as ComponentType;
  const router = createMemoryRouter(
    [
      {
        path: '/admin/mfa/enrollment',
        loader: () => ({
          status: 'authenticated',
          csrfToken: 'test-session-csrf',
          hasRecoveryAuthorization: false,
        }),
        action,
        Component,
      },
    ],
    { initialEntries: ['/admin/mfa/enrollment'] },
  );

  render(<RouterProvider router={router} />);
  return router;
}

describe('administrator MFA enrollment screen', () => {
  it('shows the protected setup result and lets the user submit a confirmation code', async () => {
    let step = 0;
    renderEnrollmentPage(() => {
      step += 1;
      return step === 1 ? { status: 'setup', setup } : { status: 'enrolled', recoveryCodes };
    });

    fireEvent.change(await screen.findByLabelText('Enrollment authorization'), {
      target: { value: 'A'.repeat(43) },
    });
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start setup' }));

    expect(
      await screen.findByRole('heading', { name: 'Set up your authenticator' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Manual setup key')).toHaveValue(setup.secret);
    expect(screen.getByLabelText('Authenticator setup link')).toHaveValue(setup.provisioningUri);

    fireEvent.change(screen.getByLabelText('Six-digit authenticator code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm authenticator' }));

    expect(
      await screen.findByRole('heading', { name: 'Save your recovery codes' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
  });

  it('shows safe enrollment denial after submitting', async () => {
    renderEnrollmentPage(() => ({ status: 'denied' }));

    fireEvent.change(await screen.findByLabelText('Enrollment authorization'), {
      target: { value: 'A'.repeat(43) },
    });
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start setup' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Administrator setup is not available for this account.',
    );
  });

  it('shows rate-limit feedback after submitting the enrollment request', async () => {
    renderEnrollmentPage(() => ({ status: 'limited' }));

    fireEvent.change(await screen.findByLabelText('Enrollment authorization'), {
      target: { value: 'A'.repeat(43) },
    });
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start setup' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Wait 15 minutes before trying again.',
    );
  });

  it('announces a pending submission accessibly', async () => {
    let finishAction!: (result: { status: 'setup'; setup: typeof setup }) => void;
    renderEnrollmentPage(
      () =>
        new Promise<{ status: 'setup'; setup: typeof setup }>((resolve) => {
          finishAction = resolve;
        }),
    );

    fireEvent.change(await screen.findByLabelText('Enrollment authorization'), {
      target: { value: 'A'.repeat(43) },
    });
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'current-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start setup' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Starting administrator setup…');
    finishAction({ status: 'setup', setup });
    expect(
      await screen.findByRole('heading', { name: 'Set up your authenticator' }),
    ).toBeInTheDocument();
  });
});
