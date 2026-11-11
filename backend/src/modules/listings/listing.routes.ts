import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ListingImageUploadTooLargeError,
  UnsupportedListingImageError,
  MAX_LISTING_IMAGE_FILE_BYTES,
} from '../../infrastructure/storage/private-listing-image-file-store.js';
import {
  ListingImageServiceError,
  removeSellerListingImageFromDraft,
  replaceSellerListingImageAssignments,
  uploadSellerListingImage,
  type ReplaceListingImageAssignmentsInput,
} from './listing-image.service.js';
import type { ApiErrorResponse, ApiSuccess } from '../../http/contract.js';
import { apiErrorResponseSchema } from '../../http/contract.js';
import { requireWorkspaceAccess } from '../../http/guards/authorize-workspace.js';
import {
  createSellerListing,
  getSellerListing,
  listSellerListings,
  SellerListingServiceError,
  updateSellerListingDraft,
  type CreateSellerListingInput,
  type SellerListingPagination,
  type UpdateSellerListingDraftInput,
} from './listing.service.js';
import {
  patchSellerListingVariant,
  type PatchSellerListingVariantInput,
} from './listing-variant.service.js';
import {
  getSellerListingImageFile,
  listSellerListingDraftImages,
} from './listing-image-read.service.js';
import { getSellerListingReadiness } from './listing-readiness.service.js';
import {
  createSellerListingRequestSchema,
  patchSellerListingVariantRequestSchema,
  sellerListingIdParamsSchema,
  sellerListingListResponseSchema,
  sellerListingPaginationQuerySchema,
  sellerListingResponseSchema,
  sellerListingVariantParamsSchema,
  sellerListingVariantResponseEnvelopeSchema,
  updateSellerListingDraftRequestSchema,
  replaceSellerListingImageAssignmentsRequestSchema,
  sellerListingImageAssignmentsResponseSchema,
  sellerListingImageParamsSchema,
  sellerListingImageUploadQuerySchema,
  sellerListingImageUploadResponseSchema,
  sellerListingImagesReadResponseSchema,
  sellerListingReadinessResponseSchema,
} from './listing.schema.js';

interface ListingImageParams extends ListingParams {
  imageId: string;
}

interface ListingImageUploadQuery {
  expectedDraftRevision: number;
}

function sendListingImageError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof ListingImageServiceError) {
    const isValidation = error.statusCode === 400;

    return reply.code(error.statusCode).send({
      error: {
        code: isValidation ? 'VALIDATION_ERROR' : 'REQUEST_ERROR',
        message: isValidation ? 'Request validation failed' : 'Request failed',
        ...(isValidation && error.field && error.rule
          ? { details: [{ field: error.field, rule: error.rule }] }
          : {}),
      },
      requestId: request.id,
    } satisfies ApiErrorResponse);
  }

  if (
    error instanceof ListingImageUploadTooLargeError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'FST_REQ_FILE_TOO_LARGE')
  ) {
    return reply.code(413).send(requestError(request.id));
  }

  if (error instanceof UnsupportedListingImageError) {
    return reply.code(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: [{ field: 'file', rule: 'unsupported_type' }],
      },
      requestId: request.id,
    } satisfies ApiErrorResponse);
  }

  throw error;
}

interface ListingParams {
  id: string;
}

interface ListingVariantParams extends ListingParams {
  variantId: string;
}

interface ListingQuery {
  limit?: number;
  offset?: number;
}

function requestError(requestId: string): ApiErrorResponse {
  return {
    error: { code: 'REQUEST_ERROR', message: 'Request failed' },
    requestId,
  };
}

function sendServiceError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (!(error instanceof SellerListingServiceError)) {
    throw error;
  }

  const isValidation = error.statusCode === 400;

  return reply.code(error.statusCode).send({
    error: {
      code: isValidation ? 'VALIDATION_ERROR' : 'REQUEST_ERROR',
      message: isValidation ? 'Request validation failed' : 'Request failed',
      ...(isValidation && error.field && error.rule
        ? { details: [{ field: error.field, rule: error.rule }] }
        : {}),
    },
    requestId: request.id,
  } satisfies ApiErrorResponse);
}

export function registerSellerListingRoutes(app: FastifyInstance): void {
  app.post<{ Body: CreateSellerListingInput }>(
    '/api/v1/seller/listings',
    {
      preHandler: requireWorkspaceAccess('seller'),
      schema: {
        tags: ['Seller listings'],
        summary: 'Create a seller listing draft',
        body: createSellerListingRequestSchema,
        response: {
          201: sellerListingResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const listing = await createSellerListing(
          app.db,
          request.identitySession.userId,
          request.body,
        );
        const response: ApiSuccess<{ listing: typeof listing }> = {
          data: { listing },
        };

        return reply.code(201).send(response);
      } catch (error) {
        return sendServiceError(error, request, reply);
      }
    },
  );

  app.get<{ Querystring: ListingQuery }>(
    '/api/v1/seller/listings',
    {
      preHandler: requireWorkspaceAccess('seller'),
      schema: {
        tags: ['Seller listings'],
        summary: 'List the authenticated seller’s listings',
        querystring: sellerListingPaginationQuerySchema,
        response: {
          200: sellerListingListResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const pagination: SellerListingPagination = {
          limit: request.query.limit ?? 25,
          offset: request.query.offset ?? 0,
        };
        const result = await listSellerListings(app.db, request.identitySession.userId, pagination);
        const response: ApiSuccess<typeof result> = { data: result };

        return reply.code(200).send(response);
      } catch (error) {
        return sendServiceError(error, request, reply);
      }
    },
  );

  app.get<{ Params: ListingParams }>(
    '/api/v1/seller/listings/:id',
    {
      preHandler: requireWorkspaceAccess('seller'),
      schema: {
        tags: ['Seller listings'],
        summary: 'Get an owned seller listing',
        params: sellerListingIdParamsSchema,
        response: {
          200: sellerListingResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const listing = await getSellerListing(
          app.db,
          request.identitySession.userId,
          request.params.id,
        );
        const response: ApiSuccess<{ listing: typeof listing }> = {
          data: { listing },
        };

        return reply.code(200).send(response);
      } catch (error) {
        return sendServiceError(error, request, reply);
      }
    },
  );

  app.get<{ Params: ListingParams }>(
    '/api/v1/seller/listings/:id/readiness',
    {
      preHandler: requireWorkspaceAccess('seller'),
      schema: {
        tags: ['Seller listings'],
        summary: 'Evaluate completeness of an owned listing draft',
        params: sellerListingIdParamsSchema,
        response: {
          200: sellerListingReadinessResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !app.listingImageFileStore || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const readiness = await getSellerListingReadiness(
          app.db,
          app.listingImageFileStore,
          request.identitySession.userId,
          request.params.id,
        );

        return reply.code(200).send({ data: readiness });
      } catch (error) {
        return sendServiceError(error, request, reply);
      }
    },
  );

  app.patch<{
    Params: ListingParams;
    Body: UpdateSellerListingDraftInput;
  }>(
    '/api/v1/seller/listings/:id/draft',
    {
      preHandler: requireWorkspaceAccess('seller'),
      schema: {
        tags: ['Seller listings'],
        summary: 'Update an owned listing draft',
        params: sellerListingIdParamsSchema,
        body: updateSellerListingDraftRequestSchema,
        response: {
          200: sellerListingResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const listing = await updateSellerListingDraft(
          app.db,
          request.identitySession.userId,
          request.params.id,
          request.body,
        );
        const response: ApiSuccess<{ listing: typeof listing }> = {
          data: { listing },
        };

        return reply.code(200).send(response);
      } catch (error) {
        return sendServiceError(error, request, reply);
      }
    },
  );

  app.patch<{
    Params: ListingVariantParams;
    Body: PatchSellerListingVariantInput;
  }>(
    '/api/v1/seller/listings/:id/variants/:variantId',
    {
      preHandler: requireWorkspaceAccess('seller'),
      schema: {
        tags: ['Seller listings'],
        summary: 'Update an owned sellable listing variant',
        params: sellerListingVariantParamsSchema,
        body: patchSellerListingVariantRequestSchema,
        response: {
          200: sellerListingVariantResponseEnvelopeSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const variant = await patchSellerListingVariant(
          app.db,
          request.identitySession.userId,
          request.params.id,
          request.params.variantId,
          request.body,
        );
        const response: ApiSuccess<{ variant: typeof variant }> = {
          data: { variant },
        };

        return reply.code(200).send(response);
      } catch (error) {
        return sendServiceError(error, request, reply);
      }
    },
  );

  app.post<{ Params: ListingParams; Querystring: ListingImageUploadQuery }>(
    '/api/v1/seller/listings/:id/images',
    {
      preHandler: requireWorkspaceAccess('seller'),
      schema: {
        tags: ['Seller listings'],
        summary: 'Upload an image to an owned listing draft',
        consumes: ['multipart/form-data'],
        params: sellerListingIdParamsSchema,
        querystring: sellerListingImageUploadQuerySchema,
        response: {
          200: sellerListingImageUploadResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          413: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !app.listingImageFileStore || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      let staged: Awaited<ReturnType<typeof app.listingImageFileStore.stage>> | undefined;

      try {
        const part = await request.file({
          limits: {
            files: 1,
            fields: 0,
            fileSize: MAX_LISTING_IMAGE_FILE_BYTES,
          },
        });

        if (!part) {
          return reply.code(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Request validation failed',
              details: [{ field: 'file', rule: 'required' }],
            },
            requestId: request.id,
          } satisfies ApiErrorResponse);
        }

        staged = await app.listingImageFileStore.stage(part.file, part.mimetype);

        if (part.file.truncated) {
          throw new ListingImageUploadTooLargeError();
        }

        const data = await uploadSellerListingImage(app.db, app.listingImageFileStore, {
          sellerId: request.identitySession.userId,
          listingId: request.params.id,
          expectedDraftRevision: request.query.expectedDraftRevision,
          staged,
        });

        return reply.code(200).send({ data });
      } catch (error) {
        if (staged) {
          await app.listingImageFileStore.discardStaged(staged).catch(() => undefined);
        }

        return sendListingImageError(error, request, reply);
      }
    },
  );

  app.patch<{
    Params: ListingParams;
    Body: ReplaceListingImageAssignmentsInput;
  }>(
    '/api/v1/seller/listings/:id/images',
    {
      preHandler: requireWorkspaceAccess('seller'),
      schema: {
        tags: ['Seller listings'],
        summary: 'Replace image ordering and variant assignments in a draft',
        params: sellerListingIdParamsSchema,
        body: replaceSellerListingImageAssignmentsRequestSchema,
        response: {
          200: sellerListingImageAssignmentsResponseSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const data = await replaceSellerListingImageAssignments(app.db, {
          sellerId: request.identitySession.userId,
          listingId: request.params.id,
          body: request.body,
        });

        return reply.code(200).send({ data });
      } catch (error) {
        return sendListingImageError(error, request, reply);
      }
    },
  );

  app.delete<{ Params: ListingImageParams; Querystring: ListingImageUploadQuery }>(
    '/api/v1/seller/listings/:id/images/:imageId',
    {
      preHandler: requireWorkspaceAccess('seller'),
      schema: {
        tags: ['Seller listings'],
        summary: 'Remove an image from an owned listing draft',
        params: sellerListingImageParamsSchema,
        querystring: sellerListingImageUploadQuerySchema,
        response: {
          200: sellerListingImageAssignmentsResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const data = await removeSellerListingImageFromDraft(app.db, {
          sellerId: request.identitySession.userId,
          listingId: request.params.id,
          imageId: request.params.imageId,
          expectedDraftRevision: request.query.expectedDraftRevision,
        });

        return reply.code(200).send({ data });
      } catch (error) {
        return sendListingImageError(error, request, reply);
      }
    },
  );

  app.get<{ Params: ListingParams }>(
    '/api/v1/seller/listings/:id/images',
    {
      preHandler: requireWorkspaceAccess('seller'),
      schema: {
        tags: ['Seller listings'],
        summary: 'List safe image metadata for an owned listing draft',
        params: sellerListingIdParamsSchema,
        response: {
          200: sellerListingImagesReadResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');

      if (!app.db || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const data = await listSellerListingDraftImages(
          app.db,
          request.identitySession.userId,
          request.params.id,
        );

        return reply.code(200).send({ data });
      } catch (error) {
        return sendListingImageError(error, request, reply);
      }
    },
  );

  app.get<{ Params: ListingImageParams }>(
    '/api/v1/seller/listings/:id/images/:imageId',
    {
      preHandler: requireWorkspaceAccess('seller'),
      schema: {
        tags: ['Seller listings'],
        summary: 'Read an owned listing image',
        params: sellerListingImageParamsSchema,
        response: {
          200: { type: 'string', format: 'binary' },
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      reply.header('x-content-type-options', 'nosniff');

      if (!app.db || !app.listingImageFileStore || !request.identitySession) {
        return reply.code(503).send(requestError(request.id));
      }

      try {
        const image = await getSellerListingImageFile(
          app.db,
          request.identitySession.userId,
          request.params.id,
          request.params.imageId,
        );

        reply.type(image.mediaType);
        reply.header('content-length', image.byteSize);
        reply.header('content-disposition', 'inline; filename="listing-image"');

        return reply.send(app.listingImageFileStore.openStored(image.storageKey));
      } catch (error) {
        return sendListingImageError(error, request, reply);
      }
    },
  );
}
