import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export function generateRequestId(): string {
  return randomUUID();
}

export async function setRequestIdHeader(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.header('x-request-id', request.id);
}
