import type { FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';

type PinoLoggerOptions = Exclude<NonNullable<FastifyServerOptions['logger']>, boolean>;

export function createLoggerOptions(): PinoLoggerOptions {
  const isProduction = process.env.NODE_ENV === 'production';
  const isTest = process.env.NODE_ENV === 'test';

  const baseOptions = {
    level: isTest ? ('silent' as const) : ('info' as const),
    serializers: {
      req(request: FastifyRequest) {
        return {
          id: request.id,
          method: request.method,
          url: request.routeOptions.url ?? request.url.split('?')[0],
        };
      },
      res(reply: Partial<FastifyReply> & Pick<FastifyReply, 'statusCode'>) {
        return {
          statusCode: reply.statusCode,
        };
      },
    },
    redact: {
      paths: ['req.headers', 'req.body', 'req.query'],
      censor: '[REDACTED]',
    },
  } satisfies PinoLoggerOptions;

  if (isProduction || isTest) {
    return baseOptions;
  }

  return {
    ...baseOptions,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  };
}
