import { describe, expect, it } from 'vitest';
import type { SellerWorkspaceFacts } from '../../../../src/http/guards/authorize-workspace.js';
import { isSellerWorkspaceAvailable } from '../../../../src/http/guards/authorize-workspace.js';
import { mapSellerApplicationStatus } from '../../../../src/modules/seller-onboarding/seller-workspace-facts.js';

describe('mapSellerApplicationStatus', () => {
  it.each([
    [undefined, 'not_applied'],
    ['draft', 'not_applied'],
    ['submitted', 'pending'],
    ['changes_requested', 'pending'],
    ['approved', 'approved'],
    ['rejected', 'rejected'],
  ] as const)('maps application state %s to %s', (status, expected) => {
    expect(mapSellerApplicationStatus(status)).toBe(expected);
  });
});

describe('isSellerWorkspaceAvailable', () => {
  it.each([
    [
      'approved application with active access',
      { applicationStatus: 'approved', operatingAccess: 'active' },
      true,
    ],
    [
      'approved application with missing access',
      { applicationStatus: 'approved', operatingAccess: 'inactive' },
      false,
    ],
    [
      'approved application with restricted access',
      { applicationStatus: 'approved', operatingAccess: 'suspended' },
      false,
    ],
    [
      'pending application with an inconsistent active access row',
      { applicationStatus: 'pending', operatingAccess: 'active' },
      false,
    ],
    [
      'rejected application with an inconsistent active access row',
      { applicationStatus: 'rejected', operatingAccess: 'active' },
      false,
    ],
    ['no application facts', undefined, false],
  ] as const)('returns %s', (_description, facts, expected) => {
    expect(isSellerWorkspaceAvailable(facts as SellerWorkspaceFacts | undefined)).toBe(expected);
  });
});
