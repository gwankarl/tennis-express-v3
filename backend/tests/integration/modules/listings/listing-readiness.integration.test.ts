import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../src/infrastructure/database/client.js';
import { buildApp } from '../../../../src/app.js';
import { PrivateListingImageFileStore } from '../../../../src/infrastructure/storage/private-listing-image-file-store.js';
import { catalogCategories } from '../../../../src/modules/catalog/category.table.js';
import { catalogProducts } from '../../../../src/modules/catalog/product.table.js';
import { createCatalogProduct } from '../../../../src/modules/catalog/product.service.js';
import { identityUsers } from '../../../../src/modules/identity/accounts/user.table.js';
import { createSession } from '../../../../src/modules/identity/sessions/session.service.js';
import {
  sellerListingDrafts,
  sellerListingRevisions,
  sellerListingVariants,
  sellerListings,
} from '../../../../src/modules/listings/listing.table.js';
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

let sequence = 0;
let database: DatabaseClient | undefined;
let app: FastifyInstance | undefined;
let fileStore: PrivateListingImageFileStore | undefined;
let storageDirectory: string | undefined;
let testDatabaseVerified = false;
let catalogProductId = '';
let catalogVariantId = '';

interface SellerFixture {
  id: string;
  token: string;
}

interface ListingResponse {
  data: {
    listing: {
      id: string;
      status: string;
      draft: {
        revision: number;
        catalogProductId: string;
        catalogVariantIds: string[];
        sellableVariants: Array<{
          id: string;
          catalogVariantId: string;
          sku: string;
          priceXaf: number | null;
          stockQuantity: number;
          reservedQuantity: number;
          isOfferedForSale: boolean;
          version: number;
        }>;
      } | null;
    };
  };
}

interface ReadinessResponse {
  data: {
    listingId: string;
    draftRevision: number;
    ready: boolean;
    issues: Array<{
      code: string;
      kind: 'seller_input' | 'invalid_reference';
      path: string;
      message: string;
      item?: { type: 'sellable_variant' | 'image'; id: string };
    }>;
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

async function createSeller(eligible = true): Promise<SellerFixture> {
  sequence += 1;
  const email = `listing-readiness-${runId}-${sequence}@example.test`;

  const [user] = await getDatabase()
    .db.insert(identityUsers)
    .values({
      deliveryEmail: email,
      normalizedEmail: email,
      status: 'active',
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    .returning({ id: identityUsers.id });

  if (!user) throw new Error('Could not create a synthetic account.');
  fixtureUserIds.push(user.id);

  const session = await createSession(getDatabase().db, user.id);
  if (!session) throw new Error('Could not create a synthetic session.');

  if (eligible) {
    const [application] = await getDatabase()
      .db.insert(sellerApplications)
      .values({
        userId: user.id,
        category: 'individual',
        status: 'approved',
        firstSubmittedAt: new Date('2026-01-01T00:00:00.000Z'),
      })
      .returning({ id: sellerApplications.id });

    if (!application) throw new Error('Could not create approved Seller access.');

    await getDatabase().db.insert(sellerOperatingAccess).values({
      userId: user.id,
      applicationId: application.id,
      status: 'active',
    });
  }

  return { id: user.id, token: session.rawToken };
}

async function makePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 600,
      height: 400,
      channels: 3,
      background: { r: 35, g: 115, b: 70 },
    },
  })
    .png()
    .toBuffer();
}

function request(
  seller: SellerFixture,
  method: 'GET' | 'POST' | 'PATCH',
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

async function createListing(
  seller: SellerFixture,
  fields: Record<string, unknown> = {},
): Promise<ListingResponse['data']['listing']> {
  const response = await request(seller, 'POST', '/api/v1/seller/listings', {
    catalogProductId,
    ...fields,
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

function uploadCommonImage(
  seller: SellerFixture,
  listingId: string,
  expectedDraftRevision: number,
  bytes: Buffer,
) {
  const boundary = `----tx-readiness-${randomUUID()}`;

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

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(database.pool);
  testDatabaseVerified = true;

  storageDirectory = await mkdtemp(join(tmpdir(), 'tennis-xpress-listing-readiness-'));
  fileStore = new PrivateListingImageFileStore(storageDirectory);
  await fileStore.initialize();

  const [category] = await database.db
    .insert(catalogCategories)
    .values({
      slug: `listing-readiness-${runId}`,
      name: `Synthetic readiness category ${runId}`,
      attributeRuleSetKey: 'tennis_racquets',
    })
    .returning({ id: catalogCategories.id });

  if (!category) throw new Error('Could not create a synthetic catalog category.');
  categoryIds.push(category.id);

  const product = await createCatalogProduct(database.db, {
    categoryId: category.id,
    brandId: null,
    name: `Synthetic readiness product ${runId}`,
    isVisible: true,
    fixedAttributes: {
      audience: 'adult',
      lengthInches: 27,
      gripSize: 'L2',
    },
  });

  catalogProductId = product.product.id;
  catalogVariantId = product.variants[0]!.id;
  productIds.push(product.product.id);

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
    if (app) {
      await app.close();
    } else if (database) {
      await database.close();
    }

    if (storageDirectory) {
      await rm(storageDirectory, { recursive: true, force: true });
    }
  }
});

describe('seller listing readiness endpoint', () => {
  it('returns a complete result for a default configuration and zero stock without mutating state', async () => {
    const seller = await createSeller();
    const listing = await createListing(seller, {
      title: 'Synthetic adult tennis racquet',
      description: 'Complete synthetic listing description.',
      condition: 'new',
    });
    const draft = listing.draft;
    expect(draft).not.toBeNull();

    const sellableVariant = draft!.sellableVariants[0]!;
    expect(draft!.catalogVariantIds).toEqual([catalogVariantId]);
    expect(sellableVariant.stockQuantity).toBe(0);

    const offer = await request(
      seller,
      'PATCH',
      `/api/v1/seller/listings/${listing.id}/variants/${sellableVariant.id}`,
      { expectedVersion: sellableVariant.version, priceXaf: 25000 },
    );
    expect(offer.statusCode, offer.body).toBe(200);

    const uploaded = await uploadCommonImage(seller, listing.id, draft!.revision, await makePng());
    expect(uploaded.statusCode, uploaded.body).toBe(200);

    const beforeListing = await getDatabase()
      .db.select({ status: sellerListings.status })
      .from(sellerListings)
      .where(eq(sellerListings.id, listing.id))
      .limit(1);
    const beforeDraft = await getDatabase()
      .db.select({ revision: sellerListingDrafts.revision })
      .from(sellerListingDrafts)
      .where(eq(sellerListingDrafts.listingId, listing.id))
      .limit(1);
    const beforeVariants = await getDatabase()
      .db.select({
        id: sellerListingVariants.id,
        priceXaf: sellerListingVariants.priceXaf,
        stockQuantity: sellerListingVariants.stockQuantity,
        reservedQuantity: sellerListingVariants.reservedQuantity,
        isOfferedForSale: sellerListingVariants.isOfferedForSale,
        version: sellerListingVariants.version,
      })
      .from(sellerListingVariants)
      .where(eq(sellerListingVariants.listingId, listing.id));
    const beforeRevisions = await getDatabase()
      .db.select({ id: sellerListingRevisions.id })
      .from(sellerListingRevisions)
      .where(eq(sellerListingRevisions.listingId, listing.id));

    const response = await request(
      seller,
      'GET',
      `/api/v1/seller/listings/${listing.id}/readiness`,
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.json<ReadinessResponse>().data).toMatchObject({
      listingId: listing.id,
      draftRevision: 2,
      ready: true,
      issues: [],
    });

    const afterListing = await getDatabase()
      .db.select({ status: sellerListings.status })
      .from(sellerListings)
      .where(eq(sellerListings.id, listing.id))
      .limit(1);
    const afterDraft = await getDatabase()
      .db.select({ revision: sellerListingDrafts.revision })
      .from(sellerListingDrafts)
      .where(eq(sellerListingDrafts.listingId, listing.id))
      .limit(1);
    const afterVariants = await getDatabase()
      .db.select({
        id: sellerListingVariants.id,
        priceXaf: sellerListingVariants.priceXaf,
        stockQuantity: sellerListingVariants.stockQuantity,
        reservedQuantity: sellerListingVariants.reservedQuantity,
        isOfferedForSale: sellerListingVariants.isOfferedForSale,
        version: sellerListingVariants.version,
      })
      .from(sellerListingVariants)
      .where(eq(sellerListingVariants.listingId, listing.id));
    const afterRevisions = await getDatabase()
      .db.select({ id: sellerListingRevisions.id })
      .from(sellerListingRevisions)
      .where(eq(sellerListingRevisions.listingId, listing.id));

    expect(afterListing).toEqual(beforeListing);
    expect(afterDraft).toEqual(beforeDraft);
    expect(afterVariants).toEqual(beforeVariants);
    expect(afterRevisions).toEqual(beforeRevisions);
  });

  it('reports incomplete fields while leaving the draft editable and readiness ordering stable', async () => {
    const seller = await createSeller();
    const listing = await createListing(seller);

    const first = await request(seller, 'GET', `/api/v1/seller/listings/${listing.id}/readiness`);
    const second = await request(seller, 'GET', `/api/v1/seller/listings/${listing.id}/readiness`);

    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);

    const firstResult = first.json<ReadinessResponse>().data;
    const secondResult = second.json<ReadinessResponse>().data;
    expect(firstResult.ready).toBe(false);
    expect(firstResult.issues).toEqual(secondResult.issues);
    expect(firstResult.issues.map((issue) => issue.path)).toEqual(
      [...firstResult.issues.map((issue) => issue.path)].sort(),
    );

    const saved = await request(seller, 'PATCH', `/api/v1/seller/listings/${listing.id}/draft`, {
      expectedDraftRevision: listing.draft!.revision,
      title: 'Saved after readiness evaluation',
    });

    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<ListingResponse>().data.listing.status).toBe('draft');
    expect(saved.json<ListingResponse>().data.listing.draft?.revision).toBe(2);
    expect(firstResult.draftRevision).toBe(1);
    expect(firstResult.issues.map((issue) => issue.code)).toContain('title_required');
    expect(firstResult.issues.map((issue) => issue.code)).toContain('description_required');
    expect(firstResult.issues.map((issue) => issue.code)).toContain('condition_required');
  });

  it('requires Seller eligibility and gives foreign and unknown listings the same 404', async () => {
    const owner = await createSeller();
    const otherSeller = await createSeller();
    const ineligible = await createSeller(false);
    const listing = await createListing(owner);

    const foreign = await request(
      otherSeller,
      'GET',
      `/api/v1/seller/listings/${listing.id}/readiness`,
    );
    const unknown = await request(
      otherSeller,
      'GET',
      `/api/v1/seller/listings/${randomUUID()}/readiness`,
    );
    const denied = await request(
      ineligible,
      'GET',
      `/api/v1/seller/listings/${listing.id}/readiness`,
    );
    const unauthenticated = await getApp().inject({
      method: 'GET',
      url: `/api/v1/seller/listings/${listing.id}/readiness`,
    });

    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(foreign.json<{ error: unknown }>().error).toEqual(
      unknown.json<{ error: unknown }>().error,
    );
    expect(denied.statusCode).toBe(403);
    expect(unauthenticated.statusCode).toBe(401);
  });

  it('returns a server error when private storage fails instead of reporting an image issue', async () => {
    const seller = await createSeller();
    const listing = await createListing(seller);
    const uploaded = await uploadCommonImage(
      seller,
      listing.id,
      listing.draft!.revision,
      await makePng(),
    );
    expect(uploaded.statusCode, uploaded.body).toBe(200);

    const testDatabaseUrl = requireTestDatabaseUrl(process.env);
    const failureDatabase = createDatabaseClient(testDatabaseUrl);

    class FailingImageStore extends PrivateListingImageFileStore {
      override async isStored(_storageKey: string): Promise<boolean> {
        throw new Error('Synthetic storage I/O failure.');
      }
    }

    const failingStore = new FailingImageStore(join(storageDirectory!, 'failing-store'));
    const failingApp = buildApp({
      database: failureDatabase,
      listingImageFileStore: failingStore,
    });

    try {
      await failingApp.ready();
      const response = await failingApp.inject({
        method: 'GET',
        url: `/api/v1/seller/listings/${listing.id}/readiness`,
        headers: { authorization: `Bearer ${seller.token}` },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('INTERNAL_ERROR');
    } finally {
      await failingApp.close();
    }
  });
});
