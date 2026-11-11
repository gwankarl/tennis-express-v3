import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../src/infrastructure/database/client.js';
import { buildApp } from '../../../../src/app.js';
import {
  PrivateListingImageFileStore,
  LISTING_IMAGE_STAGING_RETENTION_MS,
  MAX_LISTING_IMAGE_FILE_BYTES,
} from '../../../../src/infrastructure/storage/private-listing-image-file-store.js';
import { catalogCategories } from '../../../../src/modules/catalog/category.table.js';
import { catalogProducts } from '../../../../src/modules/catalog/product.table.js';
import { createCatalogProduct } from '../../../../src/modules/catalog/product.service.js';
import { identityUsers } from '../../../../src/modules/identity/accounts/user.table.js';
import { createSession } from '../../../../src/modules/identity/sessions/session.service.js';
import {
  sellerListingDraftImages,
  sellerListingImages,
  sellerListingRevisionImages,
} from '../../../../src/modules/listings/listing-image.table.js';
import {
  sellerListingRevisions,
  sellerListingVariants,
} from '../../../../src/modules/listings/listing.table.js';
import { cleanupSellerListingImages } from '../../../../src/modules/listings/listing-image-read.service.js';
import { sellerApplications } from '../../../../src/modules/seller-onboarding/application.table.js';
import { sellerOperatingAccess } from '../../../../src/modules/seller-onboarding/review.table.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../helpers/test-database.js';

const runId = randomUUID();
const fixtureUserIds: string[] = [];
const productIds: string[] = [];
const categoryIds: string[] = [];

let database: DatabaseClient | undefined;
let app: FastifyInstance | undefined;
let fileStore: PrivateListingImageFileStore | undefined;
let storageDirectory: string | undefined;
let testDatabaseVerified = false;
let catalogProductId = '';
let catalogVariantIds: string[] = [];
let sequence = 0;

interface SellerFixture {
  id: string;
  token: string;
}

interface ListingResponse {
  data: {
    listing: {
      id: string;
      draft: {
        revision: number;
        sellableVariants: Array<{ id: string; catalogVariantId: string }>;
      };
    };
  };
}

interface ImageData {
  id: string;
  mediaType: string;
  byteSize: number;
  width: number;
  height: number;
  assignments: Array<{
    variantId: string | null;
    sortOrder: number;
    isCover: boolean;
  }>;
}

interface ImageMutationResponse {
  data: {
    draftRevision: number;
    images: ImageData[];
  };
}

function getDatabase(): DatabaseClient {
  if (!database) throw new Error('Test database was not initialized.');
  return database;
}

function getApp(): FastifyInstance {
  if (!app) throw new Error('Test app was not initialized.');
  return app;
}

function getFileStore(): PrivateListingImageFileStore {
  if (!fileStore) throw new Error('Test image storage was not initialized.');
  return fileStore;
}

async function createSeller(): Promise<SellerFixture> {
  sequence += 1;
  const email = `listing-images-${runId}-${sequence}@example.test`;
  const [user] = await getDatabase()
    .db.insert(identityUsers)
    .values({
      deliveryEmail: email,
      normalizedEmail: email,
      status: 'active',
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    .returning({ id: identityUsers.id });

  if (!user) throw new Error('Could not create synthetic Seller account.');
  fixtureUserIds.push(user.id);

  const session = await createSession(getDatabase().db, user.id);
  if (!session) throw new Error('Could not create synthetic Seller session.');

  const [application] = await getDatabase()
    .db.insert(sellerApplications)
    .values({
      userId: user.id,
      category: 'individual',
      status: 'approved',
      firstSubmittedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    .returning({ id: sellerApplications.id });

  if (!application) throw new Error('Could not create approved Seller fixture.');

  await getDatabase().db.insert(sellerOperatingAccess).values({
    userId: user.id,
    applicationId: application.id,
    status: 'active',
  });

  return { id: user.id, token: session.rawToken };
}

async function makePng(width = 600, height = 400): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 35, g: 115, b: 70 },
    },
  })
    .png()
    .toBuffer();
}

async function createListing(seller: SellerFixture) {
  const response = await getApp().inject({
    method: 'POST',
    url: '/api/v1/seller/listings',
    headers: { authorization: `Bearer ${seller.token}` },
    payload: {
      catalogProductId,
      catalogVariantIds,
    },
  });

  expect(response.statusCode, response.body).toBe(201);
  return response.json<ListingResponse>().data.listing;
}

function multipartPayload(bytes: Buffer, boundary: string): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

function uploadImage(
  seller: SellerFixture,
  listingId: string,
  expectedDraftRevision: number,
  bytes: Buffer,
) {
  const boundary = `----tx-listing-image-${randomUUID()}`;

  return getApp().inject({
    method: 'POST',
    url: `/api/v1/seller/listings/${listingId}/images?expectedDraftRevision=${expectedDraftRevision}`,
    headers: {
      authorization: `Bearer ${seller.token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: multipartPayload(bytes, boundary),
  });
}

function imageRequest(
  seller: SellerFixture,
  method: 'GET' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) {
  return getApp().inject({
    method,
    url,
    headers: { authorization: `Bearer ${seller.token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function imageExists(imageId: string): Promise<boolean> {
  const rows = await getDatabase()
    .db.select({ id: sellerListingImages.id })
    .from(sellerListingImages)
    .where(eq(sellerListingImages.id, imageId))
    .limit(1);

  return rows.length === 1;
}

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(database.pool);
  testDatabaseVerified = true;

  storageDirectory = await mkdtemp(join(tmpdir(), 'tennis-xpress-listing-images-test-'));
  fileStore = new PrivateListingImageFileStore(storageDirectory);
  await fileStore.initialize();

  const [category] = await database.db
    .insert(catalogCategories)
    .values({
      slug: `listing-images-${runId}`,
      name: `Synthetic image category ${runId}`,
      attributeRuleSetKey: 'tennis_racquets',
    })
    .returning({ id: catalogCategories.id });

  if (!category) throw new Error('Could not create synthetic catalog category.');
  categoryIds.push(category.id);

  const product = await createCatalogProduct(database.db, {
    categoryId: category.id,
    brandId: null,
    name: `Synthetic image product ${runId}`,
    isVisible: true,
    fixedAttributes: { audience: 'adult', lengthInches: 27 },
    variantOptionKeys: ['gripSize'],
    variants: [{ optionValues: { gripSize: 'L2' } }, { optionValues: { gripSize: 'L3' } }],
  });

  productIds.push(product.product.id);
  catalogProductId = product.product.id;
  catalogVariantIds = product.variants.map((variant) => variant.id);

  app = buildApp({ database, listingImageFileStore: fileStore });
  await app.ready();
});

afterAll(async () => {
  try {
    if (database && testDatabaseVerified) {
      if (fixtureUserIds.length > 0) {
        await database.pool.query('DELETE FROM identity_users WHERE id = ANY($1::uuid[])', [
          fixtureUserIds,
        ]);
      }

      if (productIds.length > 0) {
        await database.db.delete(catalogProducts).where(inArray(catalogProducts.id, productIds));
      }

      if (categoryIds.length > 0) {
        await database.db
          .delete(catalogCategories)
          .where(inArray(catalogCategories.id, categoryIds));
      }
    }
  } finally {
    if (app) await app.close();
    else if (database) await database.close();

    if (storageDirectory) {
      await rm(storageDirectory, { recursive: true, force: true });
    }
  }
});

describe('seller listing images', () => {
  it('uploads, lists safe metadata, and retrieves private image content', async () => {
    const seller = await createSeller();
    const listing = await createListing(seller);
    const bytes = await makePng();

    const uploaded = await uploadImage(seller, listing.id, 1, bytes);
    expect(uploaded.statusCode, uploaded.body).toBe(200);

    const uploadData = uploaded.json<ImageMutationResponse>().data;
    expect(uploadData.draftRevision).toBe(2);
    expect(uploadData.images).toHaveLength(1);
    expect(uploadData.images[0]).toMatchObject({
      mediaType: 'image/png',
      width: 600,
      height: 400,
      assignments: [{ variantId: null, sortOrder: 0, isCover: true }],
    });
    expect(uploaded.body).not.toContain('storageKey');
    expect(uploaded.body).not.toContain('sha256');

    const imageId = uploadData.images[0]!.id;
    const listed = await imageRequest(
      seller,
      'GET',
      `/api/v1/seller/listings/${listing.id}/images`,
    );
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<ImageMutationResponse>().data.images[0]?.id).toBe(imageId);

    const content = await imageRequest(
      seller,
      'GET',
      `/api/v1/seller/listings/${listing.id}/images/${imageId}`,
    );
    expect(content.statusCode, content.body).toBe(200);
    expect(content.headers['content-type']).toContain('image/png');
    expect(content.headers['cache-control']).toContain('no-store');
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(content.rawPayload).byteLength).toBeGreaterThan(0);
  });

  it('uses variant assignments when present and leaves common-image fallback available otherwise', async () => {
    const seller = await createSeller();
    const listing = await createListing(seller);
    const first = await uploadImage(seller, listing.id, 1, await makePng());
    const second = await uploadImage(seller, listing.id, 2, await makePng());

    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);

    const images = second.json<ImageMutationResponse>().data.images;
    const commonImage = images[0]!;
    const variantImage = images[1]!;
    const [variantOne, variantTwo] = listing.draft.sellableVariants;

    expect(variantOne).toBeDefined();
    expect(variantTwo).toBeDefined();

    const assigned = await imageRequest(
      seller,
      'PATCH',
      `/api/v1/seller/listings/${listing.id}/images`,
      {
        expectedDraftRevision: 3,
        assignments: [
          {
            imageId: commonImage.id,
            variantId: null,
            sortOrder: 0,
            isCover: true,
          },
          {
            imageId: commonImage.id,
            variantId: variantOne!.id,
            sortOrder: 1,
            isCover: false,
          },
          {
            imageId: variantImage.id,
            variantId: variantOne!.id,
            sortOrder: 0,
            isCover: true,
          },
        ],
      },
    );

    expect(assigned.statusCode, assigned.body).toBe(200);
    const responseImages = assigned.json<ImageMutationResponse>().data.images;
    const common = responseImages.find((image) => image.id === commonImage.id)!;
    const specific = responseImages.find((image) => image.id === variantImage.id)!;

    expect(common.assignments).toContainEqual({
      variantId: null,
      sortOrder: 0,
      isCover: true,
    });
    expect(common.assignments).toContainEqual({
      variantId: variantOne!.id,
      sortOrder: 1,
      isCover: false,
    });
    expect(specific.assignments).toEqual([
      { variantId: variantOne!.id, sortOrder: 0, isCover: true },
    ]);

    // Variant two has no variant-specific assignment, so the common image set
    // remains available as its fallback.
    const variantTwoImages = responseImages.filter((image) =>
      image.assignments.some((assignment) => assignment.variantId === variantTwo!.id),
    );
    const fallbackImages = responseImages.filter((image) =>
      image.assignments.some((assignment) => assignment.variantId === null),
    );
    expect(variantTwoImages).toHaveLength(0);
    expect(fallbackImages.map((image) => image.id)).toContain(commonImage.id);
  });

  it('rejects foreign and unknown image/listing IDs with the same generic 404', async () => {
    const owner = await createSeller();
    const other = await createSeller();
    const listing = await createListing(owner);
    const uploaded = await uploadImage(owner, listing.id, 1, await makePng());
    const imageId = uploaded.json<ImageMutationResponse>().data.images[0]!.id;

    const foreignList = await imageRequest(
      other,
      'GET',
      `/api/v1/seller/listings/${listing.id}/images`,
    );
    const unknownList = await imageRequest(
      other,
      'GET',
      `/api/v1/seller/listings/${randomUUID()}/images`,
    );
    const foreignContent = await imageRequest(
      other,
      'GET',
      `/api/v1/seller/listings/${listing.id}/images/${imageId}`,
    );
    const unknownContent = await imageRequest(
      other,
      'GET',
      `/api/v1/seller/listings/${listing.id}/images/${randomUUID()}`,
    );

    expect(foreignList.statusCode).toBe(404);
    expect(unknownList.statusCode).toBe(404);
    expect(foreignContent.statusCode).toBe(404);
    expect(unknownContent.statusCode).toBe(404);
    expect(foreignList.json().error).toEqual(unknownList.json().error);
    expect(foreignContent.json().error).toEqual(unknownContent.json().error);

    const invalidImage = await imageRequest(
      owner,
      'PATCH',
      `/api/v1/seller/listings/${listing.id}/images`,
      {
        expectedDraftRevision: 2,
        assignments: [
          {
            imageId: randomUUID(),
            variantId: null,
            sortOrder: 0,
            isCover: true,
          },
        ],
      },
    );
    expect(invalidImage.statusCode).toBe(404);

    const invalidVariant = await imageRequest(
      owner,
      'PATCH',
      `/api/v1/seller/listings/${listing.id}/images`,
      {
        expectedDraftRevision: 2,
        assignments: [
          {
            imageId,
            variantId: randomUUID(),
            sortOrder: 0,
            isCover: true,
          },
        ],
      },
    );
    expect(invalidVariant.statusCode).toBe(404);
  });

  it('rejects duplicate assignments, stale writes, and competing draft updates', async () => {
    const seller = await createSeller();
    const listing = await createListing(seller);
    const uploaded = await uploadImage(seller, listing.id, 1, await makePng());
    const imageId = uploaded.json<ImageMutationResponse>().data.images[0]!.id;

    const duplicate = await imageRequest(
      seller,
      'PATCH',
      `/api/v1/seller/listings/${listing.id}/images`,
      {
        expectedDraftRevision: 2,
        assignments: [
          { imageId, variantId: null, sortOrder: 0, isCover: true },
          { imageId, variantId: null, sortOrder: 1, isCover: false },
        ],
      },
    );
    expect(duplicate.statusCode).toBe(400);

    const changes = (title: string) => ({
      expectedDraftRevision: 2,
      assignments: [{ imageId, variantId: null, sortOrder: title.length, isCover: true }],
    });
    const concurrent = await Promise.all([
      imageRequest(
        seller,
        'PATCH',
        `/api/v1/seller/listings/${listing.id}/images`,
        changes('first'),
      ),
      imageRequest(
        seller,
        'PATCH',
        `/api/v1/seller/listings/${listing.id}/images`,
        changes('second'),
      ),
    ]);

    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([200, 409]);

    const stale = await imageRequest(
      seller,
      'PATCH',
      `/api/v1/seller/listings/${listing.id}/images`,
      {
        expectedDraftRevision: 2,
        assignments: [{ imageId, variantId: null, sortOrder: 0, isCover: true }],
      },
    );
    expect(stale.statusCode).toBe(409);
  });

  it('enforces upload and image-count limits and cleans interrupted uploads', async () => {
    const seller = await createSeller();
    const listing = await createListing(seller);
    const valid = await makePng();

    const oversized = await uploadImage(
      seller,
      listing.id,
      1,
      Buffer.concat([valid, Buffer.alloc(MAX_LISTING_IMAGE_FILE_BYTES + 1)]),
    );
    expect(oversized.statusCode).toBe(413);

    const boundary = `----tx-listing-image-broken-${randomUUID()}`;
    const interrupted = await getApp().inject({
      method: 'POST',
      url: `/api/v1/seller/listings/${listing.id}/images?expectedDraftRevision=1`,
      headers: {
        authorization: `Bearer ${seller.token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="partial.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        valid,
      ]),
    });
    expect(interrupted.statusCode).toBeGreaterThanOrEqual(400);
    expect(await readdir(join(storageDirectory!, '.staging'))).toHaveLength(0);

    let revision = 1;
    for (let index = 0; index < 10; index += 1) {
      const response = await uploadImage(seller, listing.id, revision, valid);
      expect(response.statusCode, response.body).toBe(200);
      revision = response.json<ImageMutationResponse>().data.draftRevision;
    }

    const tooMany = await uploadImage(seller, listing.id, revision, valid);
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('retains revision-referenced files and removes old unreferenced files safely', async () => {
    const seller = await createSeller();
    const listing = await createListing(seller);
    const upload = await uploadImage(seller, listing.id, 1, await makePng());
    const imageId = upload.json<ImageMutationResponse>().data.images[0]!.id;
    const sellableVariantId = listing.draft.sellableVariants[0]!.id;

    const [revision] = await getDatabase()
      .db.insert(sellerListingRevisions)
      .values({
        listingId: listing.id,
        revision: 1,
        catalogProductId,
        title: 'Synthetic immutable image revision',
        description: null,
        condition: 'new',
      })
      .returning({ id: sellerListingRevisions.id });

    if (!revision) throw new Error('Could not create image retention revision fixture.');

    await getDatabase().db.insert(sellerListingRevisionImages).values({
      listingId: listing.id,
      revisionId: revision.id,
      imageId,
      variantId: sellableVariantId,
      sortOrder: 0,
      isCover: true,
    });

    const removedFromDraft = await imageRequest(
      seller,
      'DELETE',
      `/api/v1/seller/listings/${listing.id}/images/${imageId}?expectedDraftRevision=2`,
    );
    expect(removedFromDraft.statusCode, removedFromDraft.body).toBe(200);

    const imageRow = await getDatabase()
      .db.select({ storageKey: sellerListingImages.storageKey })
      .from(sellerListingImages)
      .where(eq(sellerListingImages.id, imageId))
      .limit(1);

    expect(imageRow[0]).toBeDefined();

    const now = Date.now();
    await getDatabase()
      .db.update(sellerListingImages)
      .set({ unreferencedAt: new Date(now - LISTING_IMAGE_STAGING_RETENTION_MS - 1) })
      .where(eq(sellerListingImages.id, imageId));

    const unreferencedUpload = await uploadImage(seller, listing.id, 3, await makePng());
    const unreferencedImageId = unreferencedUpload.json<ImageMutationResponse>().data.images[0]!.id;
    const unreferencedStorage = await getDatabase()
      .db.select({ storageKey: sellerListingImages.storageKey })
      .from(sellerListingImages)
      .where(eq(sellerListingImages.id, unreferencedImageId))
      .limit(1);

    await imageRequest(
      seller,
      'DELETE',
      `/api/v1/seller/listings/${listing.id}/images/${unreferencedImageId}?expectedDraftRevision=4`,
    );

    await getDatabase()
      .db.update(sellerListingImages)
      .set({ unreferencedAt: new Date(now - LISTING_IMAGE_STAGING_RETENTION_MS - 1) })
      .where(eq(sellerListingImages.id, unreferencedImageId));

    await getFileStore().setModifiedTimeForCleanup(
      'object',
      unreferencedStorage[0]!.storageKey,
      new Date(now - LISTING_IMAGE_STAGING_RETENTION_MS - 1),
    );

    await cleanupSellerListingImages(getDatabase().db, getFileStore(), now);

    expect(await imageExists(imageId)).toBe(true);
    expect(await imageExists(unreferencedImageId)).toBe(false);

    const retainedContent = await imageRequest(
      seller,
      'GET',
      `/api/v1/seller/listings/${listing.id}/images/${imageId}`,
    );
    expect(retainedContent.statusCode).toBe(200);
  });
});
