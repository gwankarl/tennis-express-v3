export interface VerifyEmailRequestBody {
  token: string;
  password: string;
}

export interface ResendVerificationRequestBody {
  email: string;
}

export interface VerifyEmailResponseData {
  status: 'verified';
}

export interface ResendVerificationResponseData {
  status: 'accepted';
}

export const verifyEmailRequestSchema = {
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
    password: {
      type: 'string',
      minLength: 15,
      maxLength: 128,
    },
  },
} as const;

export const verifyEmailResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: {
        status: { type: 'string', const: 'verified' },
      },
    },
  },
} as const;

export const resendVerificationRequestSchema = {
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

export const resendVerificationResponseSchema = {
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
