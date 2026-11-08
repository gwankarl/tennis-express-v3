import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import {
  RestrictedAccountState,
  SellerUnavailableState,
  TemporaryAccessState,
} from '~/features/auth/AccountAccessStates.js';

function renderAt(path: string, element: ReactNode) {
  const router = createMemoryRouter([{ path: '*', action: () => null, Component: () => element }], {
    initialEntries: [path],
  });

  render(<RouterProvider router={router} />);
  return router;
}

describe('protected account access states', () => {
  it('offers support and sign-out without a Buyer fallback for account restrictions', async () => {
    renderAt('/seller', <RestrictedAccountState csrfToken="session-bound-csrf" />);

    expect(
      await screen.findByRole('heading', { name: 'Account access restricted' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute(
      'href',
      'mailto:support@example.com',
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Go to Buyer workspace' })).not.toBeInTheDocument();
  });

  it('offers Buyer when Seller is unavailable and Buyer eligibility is confirmed', async () => {
    renderAt('/seller', <SellerUnavailableState buyerAvailable />);

    expect(
      await screen.findByRole('heading', { name: 'Seller workspace unavailable' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Buyer workspace' })).toHaveAttribute(
      'href',
      '/account',
    );
  });

  it('does not offer Buyer when Seller is unavailable and Buyer was not confirmed', async () => {
    renderAt('/seller', <SellerUnavailableState buyerAvailable={false} />);

    expect(
      await screen.findByRole('heading', { name: 'Seller workspace unavailable' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Go to Buyer workspace' })).not.toBeInTheDocument();
  });

  it('retries the same deep route and query after a temporary failure', async () => {
    renderAt(
      '/account/profile?tab=details',
      <TemporaryAccessState title="Profile temporarily unavailable" message="Try again." />,
    );

    expect(await screen.findByRole('link', { name: 'Try again' })).toHaveAttribute(
      'href',
      '/account/profile?tab=details',
    );
  });
});
