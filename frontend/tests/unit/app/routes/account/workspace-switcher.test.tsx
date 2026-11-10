import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { WorkspaceAvailability } from '~/.server/auth/workspaces.js';
import { WorkspaceSwitcher } from '~/features/workspaces/WorkspaceSwitcher.js';

const buyerOnly: WorkspaceAvailability = {
  defaultWorkspace: 'buyer',
  availableWorkspaces: { buyer: true, seller: false },
  sellerApplicationStatus: 'pending',
  adminEntryState: 'unavailable',
  adminMfaFactorState: null,
};

const buyerAndSeller: WorkspaceAvailability = {
  ...buyerOnly,
  availableWorkspaces: { buyer: true, seller: true },
  sellerApplicationStatus: 'approved',
};

function renderSwitcher(
  availability: WorkspaceAvailability,
  current: 'buyer' | 'seller' | 'admin' = 'buyer',
) {
  const router = createMemoryRouter(
    [
      {
        path: '/account',
        action: () => null,
        Component: () => (
          <WorkspaceSwitcher
            availability={availability}
            csrfToken="session-bound-token"
            current={current}
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
    expect(screen.queryByRole('link', { name: /admin/i })).not.toBeInTheDocument();
  });

  it('shows Buyer and Seller choices for an eligible seller', async () => {
    renderSwitcher(buyerAndSeller);

    expect(await screen.findByRole('navigation', { name: 'Workspace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buyer' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Seller' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Seller' })).toHaveAttribute('value', 'seller');
    expect(screen.queryByRole('link', { name: /admin/i })).not.toBeInTheDocument();
  });

  it('offers Admin setup when permission exists but no factor is enrolled', async () => {
    renderSwitcher({
      ...buyerOnly,
      adminEntryState: 'mfa_required',
      adminMfaFactorState: 'none',
    });

    const adminLink = await screen.findByRole('link', { name: 'Set up Admin' });
    expect(adminLink).toHaveAttribute('href', '/admin');
    expect(adminLink.closest('form')).toBeNull();
  });

  it('offers enrollment continuation for a pending factor', async () => {
    renderSwitcher({
      ...buyerOnly,
      adminEntryState: 'mfa_required',
      adminMfaFactorState: 'pending',
    });

    expect(await screen.findByRole('link', { name: 'Continue Admin setup' })).toHaveAttribute(
      'href',
      '/admin',
    );
  });

  it('offers an Admin challenge when an active factor needs elevation', async () => {
    renderSwitcher({
      ...buyerOnly,
      adminEntryState: 'mfa_required',
      adminMfaFactorState: 'active',
    });

    expect(await screen.findByRole('link', { name: 'Verify Admin' })).toHaveAttribute(
      'href',
      '/admin',
    );
  });

  it('marks Admin as current when the session is already elevated', async () => {
    renderSwitcher(
      {
        ...buyerOnly,
        adminEntryState: 'available',
        adminMfaFactorState: 'active',
      },
      'admin',
    );

    expect(await screen.findByRole('link', { name: 'Admin workspace' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
