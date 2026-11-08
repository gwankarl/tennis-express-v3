export interface LoginRequestBody {
  email: string;
  password: string;
}

export interface LoginResponseData {
  sessionToken: string;
  tokenType: 'Bearer';
  expiresAt: string;
}

export interface LogoutResponseData {
  status: 'logged_out';
}

export interface CurrentUserResponseData {
  id: string;
  email: string;
}

export const loginRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'password'],
  properties: {
    email: {
      type: 'string',
      minLength: 3,
      maxLength: 254,
      pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
    },
    // Login validates against the stored hash; it does not apply signup policy.
    password: { type: 'string', minLength: 1, maxLength: 1024 },
  },
} as const;

export const loginResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionToken', 'tokenType', 'expiresAt'],
      properties: {
        sessionToken: {
          type: 'string',
          minLength: 43,
          maxLength: 43,
          pattern: '^[A-Za-z0-9_-]{43}$',
        },
        tokenType: { type: 'string', const: 'Bearer' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  },
} as const;

export const logoutResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: {
        status: { type: 'string', const: 'logged_out' },
      },
    },
  },
} as const;

export const currentUserResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'email'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        email: { type: 'string' },
      },
    },
  },
} as const;
