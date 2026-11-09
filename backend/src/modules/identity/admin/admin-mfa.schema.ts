export interface StartAdminMfaEnrollmentBody {
  password: string;
  authorization: string;
}

export interface ConfirmAdminMfaEnrollmentBody {
  code: string;
}

export interface RecoverAdminMfaBody {
  currentPassword: string;
  recoveryCode: string;
}

export interface StartAdminMfaEnrollmentData {
  secret: string;
  provisioningUri: string;
  expiresAt: string;
}

export interface ConfirmAdminMfaEnrollmentData {
  status: 'enrolled';
  recoveryCodes: string[];
}

export interface RecoverAdminMfaData {
  status: 'recovered';
  adminHoldUntil: string;
  notificationSent: boolean;
  replacementEnrollmentAuthorization: string;
}

export interface StartAdminMfaElevationBody {
  password: string;
}

export interface ConfirmAdminMfaElevationBody {
  challenge: string;
  code: string;
}

export interface StartAdminMfaElevationData {
  challenge: string;
  expiresAt: string;
}

export interface ConfirmAdminMfaElevationData {
  sessionToken: string;
  tokenType: 'Bearer';
  expiresAt: string;
  elevatedUntil: string;
}

const oneTimeTokenPattern = '^[A-Za-z0-9_-]{43}$';

export const startAdminMfaEnrollmentRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['password', 'authorization'],
  properties: {
    password: { type: 'string', minLength: 1, maxLength: 1024 },
    authorization: {
      type: 'string',
      minLength: 43,
      maxLength: 43,
      pattern: oneTimeTokenPattern,
    },
  },
} as const;

export const startAdminMfaEnrollmentResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['secret', 'provisioningUri', 'expiresAt'],
      properties: {
        secret: { type: 'string', minLength: 32, maxLength: 64, pattern: '^[A-Z2-7]+$' },
        provisioningUri: { type: 'string', pattern: '^otpauth://totp/' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  },
} as const;

export const confirmAdminMfaEnrollmentRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code'],
  properties: {
    code: { type: 'string', pattern: '^\\d{6}$' },
  },
} as const;

export const confirmAdminMfaEnrollmentResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'recoveryCodes'],
      properties: {
        status: { type: 'string', const: 'enrolled' },
        recoveryCodes: {
          type: 'array',
          minItems: 10,
          maxItems: 10,
          items: { type: 'string', pattern: '^[A-F0-9]{8}(-[A-F0-9]{8}){3}$' },
        },
      },
    },
  },
} as const;

export const recoverAdminMfaRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['currentPassword', 'recoveryCode'],
  properties: {
    currentPassword: { type: 'string', minLength: 1, maxLength: 1024 },
    recoveryCode: {
      type: 'string',
      minLength: 32,
      maxLength: 35,
      pattern: '^[A-Fa-f0-9 -]+$',
    },
  },
} as const;

export const recoverAdminMfaResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: [
        'status',
        'adminHoldUntil',
        'notificationSent',
        'replacementEnrollmentAuthorization',
      ],
      properties: {
        status: { type: 'string', const: 'recovered' },
        adminHoldUntil: { type: 'string', format: 'date-time' },
        notificationSent: { type: 'boolean' },
        replacementEnrollmentAuthorization: {
          type: 'string',
          minLength: 43,
          maxLength: 43,
          pattern: oneTimeTokenPattern,
        },
      },
    },
  },
} as const;

export const startAdminMfaElevationRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['password'],
  properties: {
    password: { type: 'string', minLength: 1, maxLength: 1024 },
  },
} as const;

export const startAdminMfaElevationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['challenge', 'expiresAt'],
      properties: {
        challenge: {
          type: 'string',
          minLength: 43,
          maxLength: 43,
          pattern: oneTimeTokenPattern,
        },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  },
} as const;

export const confirmAdminMfaElevationRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['challenge', 'code'],
  properties: {
    challenge: {
      type: 'string',
      minLength: 43,
      maxLength: 43,
      pattern: oneTimeTokenPattern,
    },
    code: { type: 'string', pattern: '^\\d{6}$' },
  },
} as const;

export const confirmAdminMfaElevationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionToken', 'tokenType', 'expiresAt', 'elevatedUntil'],
      properties: {
        sessionToken: {
          type: 'string',
          minLength: 43,
          maxLength: 43,
          pattern: oneTimeTokenPattern,
        },
        tokenType: { type: 'string', const: 'Bearer' },
        expiresAt: { type: 'string', format: 'date-time' },
        elevatedUntil: { type: 'string', format: 'date-time' },
      },
    },
  },
} as const;
