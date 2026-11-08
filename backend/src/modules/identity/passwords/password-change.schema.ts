export interface ChangePasswordRequestBody {
  currentPassword: string;
  newPassword: string;
}

export interface ChangePasswordResponseData {
  status: 'changed';
}

export const changePasswordRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['currentPassword', 'newPassword'],
  properties: {
    currentPassword: { type: 'string', minLength: 1, maxLength: 1024 },
    // The shared policy checks normalized Unicode code points in the service.
    newPassword: { type: 'string', minLength: 1, maxLength: 512 },
  },
} as const;

export const changePasswordResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: {
        status: { type: 'string', const: 'changed' },
      },
    },
  },
} as const;
