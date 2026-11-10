import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/.server/env.js', () => ({ loadFrontendConfig: vi.fn() }));
vi.mock('~/.server/api-client.js', () => ({
  ApiRequestError: class ApiRequestError extends Error {},
  requestJson: vi.fn(),
}));
vi.mock('~/.server/auth/request-protection.js', () => ({
  RequestProtectionError: class RequestProtectionError extends Error {},
  withProtectedSessionFormRequest: vi.fn(),
}));
vi.mock('~/.server/auth/session.js', () => ({
  clearSessionCookie: vi.fn(),
  loadProtectedUser: vi.fn(),
  readSessionToken: vi.fn(),
  safeReturnTo: (value: string) => value,
}));

import SellerApplicationEditPage from '~/routes/account/seller-application-edit.js';

const timestamps = {
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
};

function makeApplication(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'c8ca75f9-7d53-4a5c-aee4-8639eb1ff221',
    category: 'individual',
    status: 'draft',
    revision: 3,
    legalName: 'Applicant Name',
    sellerDisplayName: 'Yaounde Tennis',
    areaServed: 'Mfoundi',
    contactPhone: null,
    registeredBusinessName: null,
    businessRole: null,
    storefrontName: null,
    proofOfAuthorityRequired: false,
    evidence: [],
    ...timestamps,
    ...overrides,
  };
}

function renderEditor({
  application = null,
  newApplication = false,
}: {
  application?: ReturnType<typeof makeApplication> | null;
  newApplication?: boolean;
} = {}) {
  const router = createMemoryRouter(
    [
      {
        path: '/account/seller-application/edit',
        loader: () => ({
          status: 'loaded',
          application,
          csrfToken: 'session-csrf',
          newApplication,
        }),
        action: () => undefined,
        Component: SellerApplicationEditPage,
      },
    ],
    { initialEntries: ['/account/seller-application/edit'] },
  );

  render(<RouterProvider router={router} />);
  return router;
}

describe('seller application draft editor', () => {
  it('shows Individual fields for a new draft and switches to Commercial fields', async () => {
    renderEditor();

    expect(await screen.findByLabelText('Seller category')).toHaveValue('individual');
    expect(screen.getByLabelText('Seller display name')).toBeInTheDocument();
    expect(screen.queryByLabelText('Registered business name')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Seller category'), {
      target: { value: 'commercial' },
    });

    expect(screen.getByLabelText('Applicant’s legal name')).toBeInTheDocument();
    expect(screen.getByLabelText('Registered business name')).toBeInTheDocument();
    expect(screen.getByLabelText('Your role in the business')).toBeInTheDocument();
    expect(screen.getByLabelText('Storefront name (optional)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Seller display name')).not.toBeInTheDocument();
  });

  it('resumes a Draft with its saved category and field values', async () => {
    renderEditor({ application: makeApplication() });

    expect(
      await screen.findByRole('heading', { name: 'Edit your seller application' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Seller category')).toHaveValue('individual');
    expect(screen.getByLabelText('Applicant’s legal name')).toHaveValue('Applicant Name');
    expect(screen.getByLabelText('Seller display name')).toHaveValue('Yaounde Tennis');
    expect(screen.getByLabelText('Area served in Yaoundé')).toHaveValue('Mfoundi');
    expect(screen.getByText('Save draft')).toBeInTheDocument();
  });

  it('shows requested proof of authority on a Commercial resubmission', async () => {
    renderEditor({
      application: makeApplication({
        category: 'commercial',
        status: 'changes_requested',
        proofOfAuthorityRequired: true,
        registeredBusinessName: 'Synthetic Tennis Ltd',
        businessRole: 'Owner',
      }),
    });

    expect(await screen.findByText('Required documents')).toBeInTheDocument();
    expect(screen.getByText('Proof of authority')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit application' })).toBeInTheDocument();
  });

  it('keeps the category locked when resuming Changes requested', async () => {
    renderEditor({
      application: makeApplication({
        category: 'commercial',
        status: 'changes_requested',
        sellerDisplayName: null,
        registeredBusinessName: 'Synthetic Tennis Ltd',
        businessRole: 'Owner',
      }),
    });

    expect(await screen.findByText('Category:')).toBeInTheDocument();
    expect(screen.getByText('Commercial')).toBeInTheDocument();
    expect(screen.queryByLabelText('Seller category')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Registered business name')).toHaveValue('Synthetic Tennis Ltd');
  });
});
