import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, Link, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../app/.server/env.js', () => ({
  loadFrontendConfig: vi.fn(),
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return {
    ...actual,
    Links: () => null,
    Meta: () => null,
    Scripts: () => null,
    ScrollRestoration: () => null,
  };
});

import NotFound from '../../../app/routes/not-found.js';
import RootApp, { ErrorBoundary as RootErrorBoundary } from '../../../app/root.js';

describe('shared UI states', () => {
  it('renders a friendly not-found page with a home link', () => {
    render(
      <RouterProvider
        router={createMemoryRouter([
          {
            path: '*',
            Component: NotFound,
          },
        ])}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Page not found.' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Return home' })).toHaveAttribute('href', '/');
  });

  it('renders the safe root fallback without exposing error details', async () => {
    const router = createMemoryRouter([
      {
        path: '/',
        Component: RootApp,
        ErrorBoundary: RootErrorBoundary,
        children: [
          {
            index: true,
            loader() {
              throw new Error('private server detail');
            },
            Component: () => <p>Route content</p>,
          },
        ],
      },
    ]);

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
    expect(screen.queryByText('private server detail')).not.toBeInTheDocument();
  });

  it('shows accessible pending feedback while a route loader is running', async () => {
    let finishNavigation!: (value: null) => void;

    const pendingLoader = () =>
      new Promise<null>((resolve) => {
        finishNavigation = resolve;
      });

    function StartPage() {
      return <Link to="/next">Open next page</Link>;
    }

    function NextPage() {
      return <p>Next page loaded</p>;
    }

    const router = createMemoryRouter(
      [
        {
          path: '/',
          Component: RootApp,
          children: [
            { index: true, Component: StartPage },
            { path: 'next', loader: pendingLoader, Component: NextPage },
          ],
        },
      ],
      { initialEntries: ['/'] },
    );

    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByRole('link', { name: 'Open next page' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Loading page…');

    await act(async () => {
      finishNavigation(null);
    });

    expect(await screen.findByText('Next page loaded')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
