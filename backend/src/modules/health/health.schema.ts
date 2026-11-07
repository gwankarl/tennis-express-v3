export interface ReadinessResponseData {
  status: 'ready';
}

export const readinessResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: {
        status: { type: 'string', const: 'ready' },
      },
    },
  },
} as const;

export interface HealthResponseData {
  status: 'ok';
}

export const healthResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: {
        status: { type: 'string', const: 'ok' },
      },
    },
  },
} as const;
