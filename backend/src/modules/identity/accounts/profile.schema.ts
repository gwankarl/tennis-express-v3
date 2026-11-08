export interface UserProfileResponseData {
  id: string;
  displayName: string | null;
  email: string;
  emailVerifiedAt: string;
}

export interface UpdateUserProfileRequestBody {
  displayName: string;
}

export const updateUserProfileRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['displayName'],
  properties: {
    displayName: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
    },
  },
} as const;

export const userProfileResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'displayName', 'email', 'emailVerifiedAt'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        displayName: { type: ['string', 'null'], maxLength: 100 },
        email: { type: 'string' },
        emailVerifiedAt: { type: 'string', format: 'date-time' },
      },
    },
  },
} as const;
