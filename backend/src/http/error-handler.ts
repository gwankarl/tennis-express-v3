import type { FastifyError, FastifyInstance } from 'fastify';
import type { ApiErrorCode, ApiErrorDetail, ApiErrorResponse } from './contract.js';

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const statusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    const isValidationError = statusCode === 400;
    const isUnexpected = statusCode >= 500;

    const code: ApiErrorCode = isUnexpected
      ? 'INTERNAL_ERROR'
      : isValidationError
        ? 'VALIDATION_ERROR'
        : 'REQUEST_ERROR';

    const details: ApiErrorDetail[] =
      isValidationError && Array.isArray(error.validation)
        ? error.validation.map(({ instancePath, keyword }) => ({
            field: instancePath || 'request',
            rule: keyword,
          }))
        : [];

    if (isUnexpected) {
      request.log.error(
        {
          errorName: error.name,
          errorCode: error.code,
          statusCode,
          requestId: request.id,
        },
        'Unhandled request error',
      );
    } else {
      request.log.warn(
        { errorCode: error.code, statusCode, requestId: request.id },
        'Request failed',
      );
    }

    const body: ApiErrorResponse = {
      error: {
        code,
        message: isUnexpected
          ? 'An unexpected error occurred'
          : isValidationError
            ? 'Request validation failed'
            : 'Request failed',
        ...(isValidationError ? { details } : {}),
      },
      requestId: request.id,
    };

    return reply.status(isUnexpected ? 500 : statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ApiErrorResponse = {
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'Route not found',
      },
      requestId: request.id,
    };

    return reply.status(404).send(body);
  });
}
