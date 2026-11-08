export interface ForgotPasswordRequestBody {
  email: string;
}

export interface ResetPasswordRequestBody {
  token: string;
  password: string;
}

export interface ForgotPasswordResponseData {
  status: 'accepted';
}

export interface ResetPasswordResponseData {
  status: 'reset';
}

export const forgotPasswordRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email'],
  properties: {
    email: {
      type: 'string',
      minLength: 3,
      maxLength: 254,
      pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
    },
  },
} as const;

export const forgotPasswordResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: {
        status: { type: 'string', const: 'accepted' },
      },
    },
  },
} as const;

export const resetPasswordRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['token', 'password'],
  properties: {
    token: {
      type: 'string',
      minLength: 43,
      maxLength: 43,
      pattern: '^[A-Za-z0-9_-]{43}$',
    },
    // The shared policy counts normalized Unicode code points in the service.
    password: { type: 'string', minLength: 1, maxLength: 512 },
  },
} as const;

export const resetPasswordResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: {
        status: { type: 'string', const: 'reset' },
      },
    },
  },
} as const;
