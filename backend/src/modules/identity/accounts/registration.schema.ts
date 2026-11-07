export interface RegistrationRequestBody {
  email: string;
  password: string;
}

export interface RegistrationResponseData {
  status: 'accepted';
}

export const registrationRequestSchema = {
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
    password: {
      type: 'string',
      minLength: 15,
      maxLength: 128,
    },
  },
} as const;

export const registrationResponseSchema = {
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
