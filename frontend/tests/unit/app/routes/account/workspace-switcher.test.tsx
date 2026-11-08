import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { WorkspaceSwitcher } from '~/features/workspaces/WorkspaceSwitcher.js';

const buyerOnly = {
  defaultWorkspace: 'buyer' as const,
  availableWorkspaces: { buyer: true as const, seller: false },
  sellerApplicationStatus: 'pending' as const,
  adminEntryState: 'unavailable' as const,
};

const buyerAndSeller = {
  ...buyerOnly,
  availableWorkspaces: { buyer: true as const, seller: true },
  sellerApplicationStatus: 'approved' as const,
};

function renderSwitcher(availability: typeof buyerOnly | typeof buyerAndSeller) {
  const router = createMemoryRouter(
    [
      {
        path: '/account',
        action: () => null,
        Component: () => (
          <WorkspaceSwitcher
            availability={availability}
            csrfToken="session-bound-token"
            current="buyer"
            submitting={false}
          />
        ),
      },
    ],
    { initialEntries: ['/account'] },
  );

  render(<RouterProvider router={router} />);
}

describe('WorkspaceSwitcher', () => {
  it('keeps navigation simple when only Buyer is available', async () => {
    renderSwitcher(buyerOnly);

    expect(await screen.findByText('Buyer workspace')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Workspace' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Seller' })).not.toBeInTheDocument();
  });

  it('shows keyboard-operable Buyer and Seller choices for an eligible seller', async () => {
    renderSwitcher(buyerAndSeller);

    expect(await screen.findByRole('navigation', { name: 'Workspace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buyer' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Seller' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Seller' })).toHaveAttribute('value', 'seller');
  });
});
