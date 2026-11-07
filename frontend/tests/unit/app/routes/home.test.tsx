import type { ComponentType } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../app/.server/api-client.js', () => ({
  ApiRequestError: class ApiRequestError extends Error {},
  requestJson: vi.fn(),
}));

import Home from '../../../../app/routes/home.js';

type HomeTestProps = {
  loaderData: {
    backendStatus: 'available' | 'unavailable';
  };
};

const HomeForTest = Home as unknown as ComponentType<HomeTestProps>;

describe('home backend status', () => {
  it.each([
    ['available', 'Backend available'],
    ['unavailable', 'Backend unavailable'],
  ] as const)('renders %s status accessibly', (backendStatus, message) => {
    render(<HomeForTest loaderData={{ backendStatus }} />);

    expect(screen.getByRole('status')).toHaveTextContent(message);
  });
});
