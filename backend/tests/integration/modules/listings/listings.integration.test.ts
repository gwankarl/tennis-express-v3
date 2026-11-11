import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../src/infrastructure/database/client.js';
import { buildApp } from '../../../../src/app.js';
import { catalogCategories } from '../../../../src/modules/catalog/category.table.js';
import { catalogProducts } from '../../../../src/modules/catalog/product.table.js';
import {
  createCatalogProduct,
  updateCatalogProduct,
} from '../../../../src/modules/catalog/product.service.js';
import { catalogVariants } from '../../../../src/modules/catalog/variant.table.js';
import { identityUsers } from '../../../../src/modules/identity/accounts/user.table.js';
import { createSession } from '../../../../src/modules/identity/sessions/session.service.js';
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
let testDatabaseVerified = false;
let catalogProductId = '';
let catalogVariantIds: string[] = [];

interface SellerFixture {
  id: string;
  token: string;
}

interface ListingDraft {
  revision: number;
  catalogProductId: string;
  catalogVariantIds: string[];
  title: string | null;
  description: string | null;
  condition: 'new' | 'like_new' | 'good' | 'fair' | null;
}

interface ListingData {
  id: string;
  status: 'draft' | 'submitted' | 'changes_requested' | 'rejected' | 'approved';
  controlRevision: number;
  approvedRevisionId: string | null;
  draft: ListingDraft | null;
}

interface ListingResponse {
  data: { listing: ListingData };
}

interface ListingListResponse {
  data: { items: ListingData[]; limit: number; offset: number };
}

function getDatabase(): DatabaseClient {
  if (!database) {
    throw new Error('Test database was not initialized.');
  }

  return database;
}

function getApp(): FastifyInstance {
  if (!app) {
    throw new Error('Test app was not initialized.');
  }

  return app;
}

async function createSeller(eligible = true): Promise<SellerFixture> {
  sequence += 1;
  const email = `listing-${runId}-${sequence}@example.test`;

  const [user] = await getDatabase()
    .db.insert(identityUsers)
    .values({
      deliveryEmail: email,
      normalizedEmail: email,
      status: 'active',
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    .returning({ id: identityUsers.id });

  if (!user) {
    throw new Error('Could not create a synthetic listing test user.');
  }

  fixtureUserIds.push(user.id);

  const session = await createSession(getDatabase().db, user.id);
  if (!session) {
    throw new Error('Could not create a synthetic listing test session.');
  }

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

    if (!application) {
      throw new Error('Could not create the approved Seller fixture.');
    }

    await getDatabase().db.insert(sellerOperatingAccess).values({
      userId: user.id,
      applicationId: application.id,
      status: 'active',
    });
  }

  return { id: user.id, token: session.rawToken };
}

async function createCatalogProductFixture(name: string) {
  const [category] = await getDatabase()
    .db.insert(catalogCategories)
    .values({
      slug: `listing-${runId}-${productIds.length + 1}`,
      name: `Synthetic listing category ${productIds.length + 1}`,
      attributeRuleSetKey: 'tennis_racquets',
    })
    .returning({ id: catalogCategories.id });

  if (!category) {
    throw new Error('Could not create a synthetic catalog category.');
  }

  categoryIds.push(category.id);

  const result = await createCatalogProduct(getDatabase().db, {
    categoryId: category.id,
    brandId: null,
    name,
    isVisible: true,
    fixedAttributes: {
      audience: 'adult',
      lengthInches: 27,
    },
    variantOptionKeys: ['gripSize'],
    variants: [{ optionValues: { gripSize: 'L2' } }, { optionValues: { gripSize: 'L3' } }],
  });

  productIds.push(result.product.id);
  return result;
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

function createListing(seller: SellerFixture, payload: Record<string, unknown> = {}) {
  return request(seller, 'POST', '/api/v1/seller/listings', {
    catalogProductId,
    ...payload,
  });
}

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(database.pool);
  testDatabaseVerified = true;

  const product = await createCatalogProductFixture(`Synthetic listing product ${runId}`);
  catalogProductId = product.product.id;
  catalogVariantIds = product.variants.map((variant) => variant.id);

  app = buildApp({ database });
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
  }
});

describe('seller listing drafts', () => {
  it('requires authentication and current Seller eligibility', async () => {
    const unauthenticated = await getApp().inject({
      method: 'GET',
      url: '/api/v1/seller/listings',
    });
    expect(unauthenticated.statusCode).toBe(401);

    const ineligibleSeller = await createSeller(false);
    const denied = await request(ineligibleSeller, 'GET', '/api/v1/seller/listings');
    expect(denied.statusCode).toBe(403);
  });

  it('creates an incomplete draft and returns the owned listing detail', async () => {
    const seller = await createSeller();
    const created = await createListing(seller);

    expect(created.statusCode, created.body).toBe(201);
    const listing = created.json<ListingResponse>().data.listing;

    expect(listing).toMatchObject({
      status: 'draft',
      controlRevision: 1,
      approvedRevisionId: null,
      draft: {
        revision: 1,
        catalogProductId,
        catalogVariantIds: [],
        title: null,
        description: null,
        condition: null,
      },
    });

    const detail = await request(seller, 'GET', `/api/v1/seller/listings/${listing.id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<ListingResponse>().data.listing).toEqual(listing);
  });

  it('paginates only the seller’s listings in deterministic order', async () => {
    const seller = await createSeller();
    const otherSeller = await createSeller();

    const ownIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await createListing(seller);
      expect(created.statusCode, created.body).toBe(201);
      ownIds.push(created.json<ListingResponse>().data.listing.id);
    }

    const foreignListing = await createListing(otherSeller);
    expect(foreignListing.statusCode, foreignListing.body).toBe(201);

    const firstPage = await request(seller, 'GET', '/api/v1/seller/listings?limit=2&offset=0');
    const secondPage = await request(seller, 'GET', '/api/v1/seller/listings?limit=2&offset=2');

    expect(firstPage.statusCode, firstPage.body).toBe(200);
    expect(secondPage.statusCode, secondPage.body).toBe(200);

    const first = firstPage.json<ListingListResponse>().data;
    const second = secondPage.json<ListingListResponse>().data;
    const returnedIds = [...first.items, ...second.items].map((item) => item.id);

    expect(first).toMatchObject({ limit: 2, offset: 0 });
    expect(second).toMatchObject({ limit: 2, offset: 2 });
    expect(returnedIds).toHaveLength(3);
    expect(new Set(returnedIds)).toEqual(new Set(ownIds));
    expect(returnedIds).not.toContain(foreignListing.json<ListingResponse>().data.listing.id);

    const excessiveLimit = await request(seller, 'GET', '/api/v1/seller/listings?limit=101');
    expect(excessiveLimit.statusCode).toBe(400);
    expect(excessiveLimit.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns the same generic not-found response for foreign and unknown IDs', async () => {
    const owner = await createSeller();
    const otherSeller = await createSeller();
    const created = await createListing(owner);
    const listingId = created.json<ListingResponse>().data.listing.id;
    const unknownId = randomUUID();

    const foreignDetail = await request(otherSeller, 'GET', `/api/v1/seller/listings/${listingId}`);
    const unknownDetail = await request(otherSeller, 'GET', `/api/v1/seller/listings/${unknownId}`);
    const foreignPatch = await request(
      otherSeller,
      'PATCH',
      `/api/v1/seller/listings/${listingId}/draft`,
      { expectedDraftRevision: 1, title: 'Changed by another seller' },
    );

    expect(foreignDetail.statusCode).toBe(404);
    expect(unknownDetail.statusCode).toBe(404);
    expect(foreignPatch.statusCode).toBe(404);
    expect(foreignDetail.json<{ error: unknown }>().error).toEqual(
      unknownDetail.json<{ error: unknown }>().error,
    );
  });

  it('validates draft fields, rejects unexpected fields, and accepts the limits', async () => {
    const seller = await createSeller();

    const tooLongTitle = await createListing(seller, { title: 'x'.repeat(121) });
    const invalidCondition = await createListing(seller, { condition: 'excellent' });
    const unexpectedField = await createListing(seller, { sellerId: randomUUID() });

    for (const [label, response] of [
      ['too-long title', tooLongTitle],
      ['unsupported condition', invalidCondition],
      ['unexpected field', unexpectedField],
    ] as const) {
      expect(response.statusCode, `${label}: ${response.body}`).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    }

    const valid = await createListing(seller, {
      title: 'x'.repeat(120),
      description: 'x'.repeat(5000),
      condition: 'like_new',
    });
    expect(valid.statusCode, valid.body).toBe(201);
  });

  it('rejects unavailable products and configurations that belong to another product', async () => {
    const seller = await createSeller();
    const unknownProduct = await createListing(seller, { catalogProductId: randomUUID() });
    expect(unknownProduct.statusCode).toBe(400);

    const unknownConfiguration = await createListing(seller, {
      catalogVariantIds: [randomUUID()],
    });
    expect(unknownConfiguration.statusCode).toBe(400);

    const otherProduct = await createCatalogProductFixture(`Other listing product ${runId}`);
    const wrongProductConfiguration = await createListing(seller, {
      catalogVariantIds: [otherProduct.variants[0]!.id],
    });
    expect(wrongProductConfiguration.statusCode).toBe(400);
  });

  it('updates an owned draft and rejects stale and concurrent revisions', async () => {
    const seller = await createSeller();
    const created = await createListing(seller);
    const initial = created.json<ListingResponse>().data.listing;

    const updated = await request(seller, 'PATCH', `/api/v1/seller/listings/${initial.id}/draft`, {
      expectedDraftRevision: 1,
      title: '  Updated synthetic listing  ',
      catalogVariantIds: [catalogVariantIds[0]!],
      condition: 'good',
    });

    expect(updated.statusCode, updated.body).toBe(200);
    const current = updated.json<ListingResponse>().data.listing;
    expect(current.draft).toMatchObject({
      revision: 2,
      title: 'Updated synthetic listing',
      condition: 'good',
      catalogVariantIds: [catalogVariantIds[0]],
    });

    const stale = await request(seller, 'PATCH', `/api/v1/seller/listings/${initial.id}/draft`, {
      expectedDraftRevision: 1,
      title: 'Stale update',
    });
    expect(stale.statusCode).toBe(409);

    const concurrentResults = await Promise.all([
      request(seller, 'PATCH', `/api/v1/seller/listings/${initial.id}/draft`, {
        expectedDraftRevision: 2,
        title: 'Concurrent update A',
      }),
      request(seller, 'PATCH', `/api/v1/seller/listings/${initial.id}/draft`, {
        expectedDraftRevision: 2,
        title: 'Concurrent update B',
      }),
    ]);

    expect(concurrentResults.map((response) => response.statusCode).sort()).toEqual([200, 409]);

    const afterConcurrency = await request(seller, 'GET', `/api/v1/seller/listings/${initial.id}`);
    expect(afterConcurrency.json<ListingResponse>().data.listing.draft?.revision).toBe(3);
    expect(['Concurrent update A', 'Concurrent update B']).toContain(
      afterConcurrency.json<ListingResponse>().data.listing.draft?.title,
    );
  });

  it('rejects empty and stale-invalid draft updates', async () => {
    const seller = await createSeller();
    const created = await createListing(seller);
    const listingId = created.json<ListingResponse>().data.listing.id;

    const empty = await request(seller, 'PATCH', `/api/v1/seller/listings/${listingId}/draft`, {
      expectedDraftRevision: 1,
    });
    const badRevision = await request(
      seller,
      'PATCH',
      `/api/v1/seller/listings/${listingId}/draft`,
      { expectedDraftRevision: 0, title: 'Invalid revision' },
    );

    expect(empty.statusCode).toBe(400);
    expect(badRevision.statusCode).toBe(400);
  });

  it('prevents deleting a referenced catalog configuration and returns a conflict', async () => {
    const seller = await createSeller();
    const created = await createListing(seller, {
      catalogVariantIds: [catalogVariantIds[0]!],
    });
    expect(created.statusCode, created.body).toBe(201);

    const referencedVariantId = catalogVariantIds[0]!;
    await expect(
      updateCatalogProduct(getDatabase().db, catalogProductId, {
        variantOptionKeys: ['gripSize'],
        variants: [{ optionValues: { gripSize: 'L3' } }],
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      field: 'variants',
      rule: 'referenced',
    });

    const stillPresent = await getDatabase()
      .db.select({ id: catalogVariants.id })
      .from(catalogVariants)
      .where(eq(catalogVariants.id, referencedVariantId));

    expect(stillPresent).toHaveLength(1);
  });
});
