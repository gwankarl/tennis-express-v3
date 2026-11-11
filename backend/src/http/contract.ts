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
  code?: string;
  path?: string;
  kind?: string;
  message?: string;
  item?: {
    type: string;
    id: string;
  };
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
              code: { type: 'string' },
              path: { type: 'string' },
              kind: { type: 'string' },
              message: { type: 'string' },
              item: {
                type: 'object',
                required: ['type', 'id'],
                properties: {
                  type: { type: 'string' },
                  id: { type: 'string' },
                },
                additionalProperties: false,
              },
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
