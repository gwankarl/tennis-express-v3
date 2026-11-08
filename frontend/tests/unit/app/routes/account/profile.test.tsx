import { act, fireEvent, render, screen } from '@testing-library/react';
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
}));

import ProfilePage from '~/routes/account/profile.js';

interface TestProfile {
  id: string;
  displayName: string | null;
  email: string;
  emailVerifiedAt: string;
}

const emptyProfile: TestProfile = {
  id: '7ad9dc2c-308e-4a1a-8c45-a9e9e3e7b5dc',
  displayName: null,
  email: 'player@example.test',
  emailVerifiedAt: '2026-01-01T00:00:00.000Z',
};

function renderProfile(
  action: () => unknown = () => undefined,
  profile: TestProfile = emptyProfile,
) {
  const router = createMemoryRouter(
    [
      {
        path: '/account/profile',
        loader: () => ({
          status: 'authenticated',
          profile,
          csrfToken: 'session-bound-csrf',
        }),
        action,
        Component: ProfilePage,
      },
    ],
    { initialEntries: ['/account/profile'] },
  );

  render(<RouterProvider router={router} />);
  return router;
}

describe('profile page', () => {
  it('shows an empty display name and read-only verified account details', async () => {
    renderProfile();

    expect(await screen.findByRole('heading', { name: 'Edit profile' })).toBeInTheDocument();
    expect(screen.getByLabelText('Display name')).toHaveValue('');
    expect(screen.getByText('player@example.test')).toBeInTheDocument();
    expect(screen.getByText('Email status').parentElement).toHaveTextContent('Verified');
    expect(screen.getByText('Verified on').parentElement).toHaveTextContent('2026-01-01');
    expect(screen.getByLabelText('Display name')).toHaveAttribute('maxLength', '100');
  });

  it('prefills an existing display name', async () => {
    renderProfile(undefined, { ...emptyProfile, displayName: 'First Player' });

    expect(await screen.findByLabelText('Display name')).toHaveValue('First Player');
  });

  it('shows pending feedback and the saved confirmation', async () => {
    let finishAction!: (value: unknown) => void;

    renderProfile(
      () =>
        new Promise((resolve) => {
          finishAction = resolve;
        }),
    );

    const input = await screen.findByLabelText('Display name');
    fireEvent.change(input, { target: { value: 'New Player' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Saving profile');
    expect(screen.getByRole('button', { name: 'Saving profile…' })).toBeDisabled();

    await act(async () => {
      finishAction({ status: 'saved', displayName: 'New Player' });
    });

    expect(await screen.findByText('Profile saved.')).toHaveAttribute('role', 'status');
    expect(screen.getByLabelText('Display name')).toHaveValue('New Player');
  });

  it('shows inline validation and preserves the entered value', async () => {
    renderProfile(() => ({
      status: 'invalid',
      displayName: 'Player Name',
      fieldError: 'Use 100 characters or fewer.',
    }));

    const input = await screen.findByLabelText('Display name');
    fireEvent.change(input, { target: { value: 'Player Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    expect(await screen.findByText('Use 100 characters or fewer.')).toBeInTheDocument();
    expect(screen.getByLabelText('Display name')).toHaveValue('Player Name');
    expect(screen.getByLabelText('Display name')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows a safe service error and preserves the entered value', async () => {
    renderProfile(() => ({ status: 'unavailable', displayName: 'Player Name' }));

    const input = await screen.findByLabelText('Display name');
    fireEvent.change(input, { target: { value: 'Player Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Profile could not be saved. Please try again.',
    );
    expect(screen.getByLabelText('Display name')).toHaveValue('Player Name');
  });
});
