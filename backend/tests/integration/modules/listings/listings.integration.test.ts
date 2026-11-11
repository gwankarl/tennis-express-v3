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
import {
  sellerListingApprovedRevisions,
  sellerListingPriceHistory,
  sellerListingRevisionConfigurations,
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
  sellableVariants: SellableVariant[];
  title: string | null;
  description: string | null;
  condition: 'new' | 'like_new' | 'good' | 'fair' | null;
}

interface SellableVariant {
  id: string;
  catalogVariantId: string;
  sku: string;
  priceXaf: number | null;
  stockQuantity: number;
  reservedQuantity: number;
  isOfferedForSale: boolean;
  version: number;
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

async function createDefaultCatalogProductFixture(name: string) {
  const [category] = await getDatabase()
    .db.insert(catalogCategories)
    .values({
      slug: `listing-default-${runId}-${productIds.length + 1}`,
      name: `Synthetic default category ${productIds.length + 1}`,
      attributeRuleSetKey: 'tennis_racquets',
    })
    .returning({ id: catalogCategories.id });

  if (!category) {
    throw new Error('Could not create a synthetic default catalog category.');
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
      gripSize: 'L2',
    },
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

function patchVariant(
  seller: SellerFixture,
  listingId: string,
  variantId: string,
  payload: Record<string, unknown>,
) {
  return request(
    seller,
    'PATCH',
    `/api/v1/seller/listings/${listingId}/variants/${variantId}`,
    payload,
  );
}

async function addApprovedRevisionFixture(
  listingId: string,
  productId: string,
  catalogVariantIds: readonly string[],
): Promise<void> {
  await getDatabase().db.transaction(async (tx) => {
    const [revision] = await tx
      .insert(sellerListingRevisions)
      .values({
        listingId,
        revision: 1,
        catalogProductId: productId,
        title: 'Approved synthetic listing revision',
        description: null,
        condition: 'new',
      })
      .returning({ id: sellerListingRevisions.id });

    if (!revision) {
      throw new Error('Could not create the approved listing revision fixture.');
    }

    if (catalogVariantIds.length > 0) {
      await tx.insert(sellerListingRevisionConfigurations).values(
        catalogVariantIds.map((catalogVariantId) => ({
          listingId,
          revisionId: revision.id,
          catalogProductId: productId,
          catalogVariantId,
        })),
      );
    }

    await tx.insert(sellerListingApprovedRevisions).values({ listingId, revisionId: revision.id });
    await tx
      .update(sellerListings)
      .set({ status: 'changes_requested' })
      .where(eq(sellerListings.id, listingId));
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

    const unauthenticatedVariantUpdate = await getApp().inject({
      method: 'PATCH',
      url: `/api/v1/seller/listings/${randomUUID()}/variants/${randomUUID()}`,
      payload: { expectedVersion: 1, stockQuantity: 1 },
    });
    expect(unauthenticatedVariantUpdate.statusCode).toBe(401);

    const ineligibleSeller = await createSeller(false);
    const denied = await request(ineligibleSeller, 'GET', '/api/v1/seller/listings');
    expect(denied.statusCode).toBe(403);

    const deniedVariantUpdate = await patchVariant(
      ineligibleSeller,
      randomUUID(),
      randomUUID(),
      { expectedVersion: 1, stockQuantity: 1 },
    );
    expect(deniedVariantUpdate.statusCode).toBe(403);
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

  it('selects the single default catalog configuration when the draft omits selections', async () => {
    const seller = await createSeller();
    const product = await createDefaultCatalogProductFixture(`Default listing product ${runId}`);
    const defaultConfiguration = product.variants[0];
    expect(defaultConfiguration?.isDefault).toBe(true);

    const response = await createListing(seller, { catalogProductId: product.product.id });

    expect(response.statusCode, response.body).toBe(201);
    const draft = response.json<ListingResponse>().data.listing.draft;
    expect(draft?.catalogVariantIds).toEqual([defaultConfiguration?.id]);
    expect(draft?.sellableVariants).toHaveLength(1);
    expect(draft?.sellableVariants[0]).toMatchObject({
      catalogVariantId: defaultConfiguration?.id,
      priceXaf: null,
      stockQuantity: 0,
      reservedQuantity: 0,
      isOfferedForSale: false,
      version: 1,
    });
  });

  it('creates and reuses stable sellable IDs as a draft changes configuration selection', async () => {
    const seller = await createSeller();
    const created = await createListing(seller, { catalogVariantIds });
    expect(created.statusCode, created.body).toBe(201);
    const initial = created.json<ListingResponse>().data.listing;
    const initialByCatalogId = new Map(
      initial.draft?.sellableVariants.map((variant) => [variant.catalogVariantId, variant]),
    );
    expect(initialByCatalogId.size).toBe(2);

    const removeSecond = await request(
      seller,
      'PATCH',
      `/api/v1/seller/listings/${initial.id}/draft`,
      { expectedDraftRevision: 1, catalogVariantIds: [catalogVariantIds[0]!] },
    );
    expect(removeSecond.statusCode, removeSecond.body).toBe(200);
    expect(removeSecond.json<ListingResponse>().data.listing.draft?.sellableVariants).toHaveLength(1);

    const restore = await request(seller, 'PATCH', `/api/v1/seller/listings/${initial.id}/draft`, {
      expectedDraftRevision: 2,
      catalogVariantIds,
    });
    expect(restore.statusCode, restore.body).toBe(200);

    const restored = restore.json<ListingResponse>().data.listing.draft?.sellableVariants ?? [];
    for (const variant of restored) {
      const original = initialByCatalogId.get(variant.catalogVariantId);
      expect(variant.id).toBe(original?.id);
      expect(variant.sku).toBe(original?.sku);
    }

    const retained = await getDatabase()
      .db.select({ id: sellerListingVariants.id })
      .from(sellerListingVariants)
      .where(eq(sellerListingVariants.listingId, initial.id));
    expect(retained).toHaveLength(2);
  });

  it('updates approved offers while content awaits review and blocks unapproved configurations', async () => {
    const seller = await createSeller();
    const created = await createListing(seller, { catalogVariantIds });
    expect(created.statusCode, created.body).toBe(201);
    const listing = created.json<ListingResponse>().data.listing;
    const variants = listing.draft?.sellableVariants ?? [];
    const approvedVariant = variants.find((variant) => variant.catalogVariantId === catalogVariantIds[0]);
    const pendingVariant = variants.find((variant) => variant.catalogVariantId === catalogVariantIds[1]);
    expect(approvedVariant).toBeDefined();
    expect(pendingVariant).toBeDefined();

    await addApprovedRevisionFixture(listing.id, catalogProductId, [catalogVariantIds[0]!]);

    const approvedUpdate = await patchVariant(seller, listing.id, approvedVariant!.id, {
      expectedVersion: 1,
      priceXaf: 25_000,
      stockQuantity: 6,
      sku: '  racket-01  ',
      isOfferedForSale: true,
    });
    expect(approvedUpdate.statusCode, approvedUpdate.body).toBe(200);
    expect(approvedUpdate.json<{ data: { variant: SellableVariant } }>().data.variant).toMatchObject({
      id: approvedVariant!.id,
      sku: 'RACKET-01',
      priceXaf: 25_000,
      stockQuantity: 6,
      isOfferedForSale: true,
      version: 2,
    });

    const repriced = await patchVariant(seller, listing.id, approvedVariant!.id, {
      expectedVersion: 2,
      priceXaf: 26_000,
    });
    expect(repriced.statusCode, repriced.body).toBe(200);
    expect(repriced.json<{ data: { variant: SellableVariant } }>().data.variant).toMatchObject({
      priceXaf: 26_000,
      version: 3,
    });

    const excludedUpdate = await patchVariant(seller, listing.id, pendingVariant!.id, {
      expectedVersion: 1,
      priceXaf: 12_000,
      isOfferedForSale: true,
    });
    expect(excludedUpdate.statusCode).toBe(409);

    const currentListing = await request(seller, 'GET', `/api/v1/seller/listings/${listing.id}`);
    expect(currentListing.json<ListingResponse>().data.listing.status).toBe('changes_requested');

    const history = await getDatabase()
      .db.select()
      .from(sellerListingPriceHistory)
      .where(eq(sellerListingPriceHistory.sellerListingVariantId, approvedVariant!.id));
    expect(history).toHaveLength(2);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ previousPriceXaf: null, newPriceXaf: 25_000 }),
        expect.objectContaining({ previousPriceXaf: 25_000, newPriceXaf: 26_000 }),
      ]),
    );
  });

  it('enforces seller-scoped SKU uniqueness, generic ownership 404s, and reservation-safe stock', async () => {
    const seller = await createSeller();
    const otherSeller = await createSeller();
    const first = await createListing(seller, { catalogVariantIds: [catalogVariantIds[0]!] });
    const second = await createListing(seller, { catalogVariantIds: [catalogVariantIds[0]!] });
    const other = await createListing(otherSeller, { catalogVariantIds: [catalogVariantIds[0]!] });
    const firstListing = first.json<ListingResponse>().data.listing;
    const secondListing = second.json<ListingResponse>().data.listing;
    const otherListing = other.json<ListingResponse>().data.listing;
    const firstVariant = firstListing.draft!.sellableVariants[0]!;
    const secondVariant = secondListing.draft!.sellableVariants[0]!;
    const otherVariant = otherListing.draft!.sellableVariants[0]!;

    const firstSku = await patchVariant(seller, firstListing.id, firstVariant.id, {
      expectedVersion: 1,
      sku: 'seller-sku-1',
      stockQuantity: 4,
    });
    expect(firstSku.statusCode, firstSku.body).toBe(200);

    const duplicateSku = await patchVariant(seller, secondListing.id, secondVariant.id, {
      expectedVersion: 1,
      sku: 'SELLER-SKU-1',
    });
    expect(duplicateSku.statusCode).toBe(409);

    const sameSkuOtherSeller = await patchVariant(otherSeller, otherListing.id, otherVariant.id, {
      expectedVersion: 1,
      sku: 'seller-sku-1',
    });
    expect(sameSkuOtherSeller.statusCode, sameSkuOtherSeller.body).toBe(200);

    const foreign = await patchVariant(otherSeller, firstListing.id, firstVariant.id, {
      expectedVersion: 2,
      stockQuantity: 10,
    });
    const foreignVariantOnOwnedListing = await patchVariant(
      seller,
      firstListing.id,
      otherVariant.id,
      { expectedVersion: 1, stockQuantity: 10 },
    );
    const unknownVariantOnOwnedListing = await patchVariant(
      seller,
      firstListing.id,
      randomUUID(),
      { expectedVersion: 1, stockQuantity: 10 },
    );
    const unknown = await patchVariant(otherSeller, randomUUID(), randomUUID(), {
      expectedVersion: 1,
      stockQuantity: 10,
    });
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(foreign.json<{ error: unknown }>().error).toEqual(unknown.json<{ error: unknown }>().error);
    expect(foreignVariantOnOwnedListing.statusCode).toBe(404);
    expect(unknownVariantOnOwnedListing.statusCode).toBe(404);
    expect(foreignVariantOnOwnedListing.json<{ error: unknown }>().error).toEqual(
      unknownVariantOnOwnedListing.json<{ error: unknown }>().error,
    );

    await getDatabase()
      .db.update(sellerListingVariants)
      .set({ reservedQuantity: 2 })
      .where(eq(sellerListingVariants.id, firstVariant.id));
    const belowReservation = await patchVariant(seller, firstListing.id, firstVariant.id, {
      expectedVersion: 2,
      stockQuantity: 1,
    });
    expect(belowReservation.statusCode).toBe(409);

    const unchanged = await getDatabase()
      .db.select()
      .from(sellerListingVariants)
      .where(eq(sellerListingVariants.id, firstVariant.id));
    expect(unchanged[0]).toMatchObject({ stockQuantity: 4, reservedQuantity: 2, version: 2 });
  });

  it('rejects invalid operational values and allows concurrent updates to separate variants', async () => {
    const seller = await createSeller();
    const created = await createListing(seller, { catalogVariantIds });
    expect(created.statusCode, created.body).toBe(201);
    const listing = created.json<ListingResponse>().data.listing;
    const [first, second] = listing.draft!.sellableVariants;
    expect(second).toBeDefined();

    const invalidPrice = await patchVariant(seller, listing.id, first!.id, {
      expectedVersion: 1,
      priceXaf: 1.5,
    });
    const invalidStock = await patchVariant(seller, listing.id, first!.id, {
      expectedVersion: 1,
      stockQuantity: -1,
    });
    const unexpected = await patchVariant(seller, listing.id, first!.id, {
      expectedVersion: 1,
      reservedQuantity: 1,
    });
    for (const response of [invalidPrice, invalidStock, unexpected]) {
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
    }

    const separateVariantUpdates = await Promise.all([
      patchVariant(seller, listing.id, first!.id, { expectedVersion: 1, priceXaf: 10_000 }),
      patchVariant(seller, listing.id, second!.id, { expectedVersion: 1, priceXaf: 11_000 }),
    ]);
    expect(separateVariantUpdates.map((response) => response.statusCode)).toEqual([200, 200]);

    const competingUpdates = await Promise.all([
      patchVariant(seller, listing.id, first!.id, { expectedVersion: 2, stockQuantity: 2 }),
      patchVariant(seller, listing.id, first!.id, { expectedVersion: 2, stockQuantity: 3 }),
    ]);
    expect(competingUpdates.map((response) => response.statusCode).sort()).toEqual([200, 409]);

    const after = await request(seller, 'GET', `/api/v1/seller/listings/${listing.id}`);
    const finalFirst = after
      .json<ListingResponse>()
      .data.listing.draft?.sellableVariants.find((variant) => variant.id === first!.id);
    expect(finalFirst?.version).toBe(3);
    expect([2, 3]).toContain(finalFirst?.stockQuantity);
  });
});
