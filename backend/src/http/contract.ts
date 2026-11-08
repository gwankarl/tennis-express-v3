export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'ROUTE_NOT_FOUND',
  'REQUEST_ERROR',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'ACCOUNT_RESTRICTED',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiSuccess<T> {
  data: T;
}

export interface ApiErrorDetail {
  field: string;
  rule: string;
}

export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: ApiErrorDetail[];
  };
  requestId: string;
}

export const apiErrorResponseSchema = {
  type: 'object',
  required: ['error', 'requestId'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          enum: API_ERROR_CODES,
        },
        message: { type: 'string' },
        details: {
          type: 'array',
          items: {
            type: 'object',
            required: ['field', 'rule'],
            properties: {
              field: { type: 'string' },
              rule: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    requestId: { type: 'string' },
  },
  additionalProperties: false,
} as const;
