import type {
  AdminEntryState,
  AdminMfaFactorState,
  SellerApplicationStatus,
} from '../../../http/guards/authorize-workspace.js';

export interface WorkspacesResponseData {
  defaultWorkspace: 'buyer';
  adminMfaFactorState: AdminMfaFactorState;
  availableWorkspaces: {
    buyer: true;
    seller: boolean;
  };
  sellerApplicationStatus: SellerApplicationStatus | null;
  adminEntryState: AdminEntryState;
}

export const workspacesResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: [
        'defaultWorkspace',
        'availableWorkspaces',
        'sellerApplicationStatus',
        'adminEntryState',
        'adminMfaFactorState',
      ],
      properties: {
        defaultWorkspace: { type: 'string', const: 'buyer' },
        availableWorkspaces: {
          type: 'object',
          additionalProperties: false,
          required: ['buyer', 'seller'],
          properties: {
            buyer: { type: 'boolean', const: true },
            seller: { type: 'boolean' },
          },
        },
        sellerApplicationStatus: {
          type: ['string', 'null'],
          enum: ['not_applied', 'pending', 'approved', 'rejected', null],
        },
        adminEntryState: {
          type: 'string',
          enum: ['unavailable', 'mfa_required', 'available'],
        },
        adminMfaFactorState: {
          type: ['string', 'null'],
          enum: ['none', 'pending', 'active', null],
        },
      },
    },
  },
} as const;
