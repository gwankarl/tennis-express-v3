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
  sellerListingApprovedRevisions,
  sellerListingDrafts,
  sellerListingRevisionConfigurations,
  sellerListingRevisionOffers,
  sellerListingRevisions,
  sellerListingReviewOutcomes,
  sellerListingVariants,
  sellerListings,
} from '../../../../src/modules/listings/listing.table.js';
import {
  sellerListingDraftImages,
  sellerListingImages,
  sellerListingRevisionImages,
} from '../../../../src/modules/listings/listing-image.table.js';
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
      controlRevision: number;
      approvedRevisionId: string | null;
      pausedAt: string | null;
      archivedAt: string | null;
      administratorRemovedAt: string | null;
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
        title: string | null;
        description: string | null;
        condition: 'new' | 'like_new' | 'good' | 'fair' | null;
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

interface SubmissionResponse {
  data: {
    listingId: string;
    status: 'submitted';
    approvedRevisionId: string | null;
    pendingSubmission: {
      id: string;
      revision: number;
      submittedAt: string;
    };
  };
}

interface ListingWorkflowDetailResponse {
  data: {
    listing: ListingResponse['data']['listing'] & {
      pendingSubmission: {
        revisionId: string;
        revision: number;
        submittedAt: string;
      } | null;
      latestReviewOutcome: {
        revisionId: string;
        revision: number;
        decision: 'changes_requested' | 'rejected' | 'approved';
        feedback: string | null;
        reviewedAt: string;
      } | null;
    };
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

async function createCompleteDraft(seller: SellerFixture) {
  const listing = await createListing(seller, {
    title: `Synthetic listing ${randomUUID()}`,
    description: 'Synthetic complete listing for submission tests.',
    condition: 'new',
  });

  const sellableVariant = listing.draft!.sellableVariants[0]!;
  const priced = await request(
    seller,
    'PATCH',
    `/api/v1/seller/listings/${listing.id}/variants/${sellableVariant.id}`,
    {
      expectedVersion: sellableVariant.version,
      priceXaf: 25_000,
    },
  );
  expect(priced.statusCode, priced.body).toBe(200);

  const uploaded = await uploadCommonImage(
    seller,
    listing.id,
    listing.draft!.revision,
    await makePng(),
  );
  expect(uploaded.statusCode, uploaded.body).toBe(200);

  const uploadData = uploaded.json<{
    data: { draftRevision: number; images: Array<{ id: string }> };
  }>().data;

  return {
    listing,
    draftRevision: uploadData.draftRevision,
    imageId: uploadData.images[0]!.id,
    sellableVariantId: sellableVariant.id,
  };
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
        // Revisions and review outcomes retain actor identities by RESTRICT;
        // remove those synthetic audit references before cascading fixture users.
        await database.pool.query(
          `UPDATE seller_listing_revisions
              SET submitted_by_user_id = NULL
            WHERE submitted_by_user_id = ANY($1::uuid[])`,
          [fixtureUserIds],
        );
        await database.pool.query(
          `DELETE FROM seller_listing_review_outcomes
            WHERE reviewer_user_id = ANY($1::uuid[])`,
          [fixtureUserIds],
        );
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
  it('applies versioned pause, resume, archive, and restore without changing approval history', async () => {
    type ControlResponse = {
      data: {
        listing: Pick<
          ListingResponse['data']['listing'],
          | 'id'
          | 'status'
          | 'controlRevision'
          | 'approvedRevisionId'
          | 'pausedAt'
          | 'archivedAt'
          | 'administratorRemovedAt'
        >;
      };
    };

    const seller = await createSeller();
    const otherSeller = await createSeller();
    const ineligibleSeller = await createSeller(false);
    const prepared = await createCompleteDraft(seller);

    const submitted = await request(
      seller,
      'POST',
      `/api/v1/seller/listings/${prepared.listing.id}/submit`,
      { expectedDraftRevision: prepared.draftRevision },
    );
    expect(submitted.statusCode, submitted.body).toBe(200);
    const revisionId = submitted.json<SubmissionResponse>().data.pendingSubmission.id;

    const [beforeApproval] = await getDatabase()
      .db.select({ controlRevision: sellerListings.controlRevision })
      .from(sellerListings)
      .where(eq(sellerListings.id, prepared.listing.id));

    await getDatabase()
      .db.update(sellerListings)
      .set({ status: 'approved', controlRevision: beforeApproval!.controlRevision + 1 })
      .where(eq(sellerListings.id, prepared.listing.id));
    await getDatabase().db.insert(sellerListingApprovedRevisions).values({
      listingId: prepared.listing.id,
      revisionId,
    });

    const [approvedState] = await getDatabase()
      .db.select({ controlRevision: sellerListings.controlRevision })
      .from(sellerListings)
      .where(eq(sellerListings.id, prepared.listing.id));
    const base = `/api/v1/seller/listings/${prepared.listing.id}`;

    const foreign = await request(otherSeller, 'POST', `${base}/pause`, {
      expectedControlRevision: approvedState!.controlRevision,
    });
    const unknown = await request(
      otherSeller,
      'POST',
      `/api/v1/seller/listings/${randomUUID()}/pause`,
      { expectedControlRevision: approvedState!.controlRevision },
    );
    const denied = await request(ineligibleSeller, 'POST', `${base}/pause`, {
      expectedControlRevision: approvedState!.controlRevision,
    });
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(foreign.json<{ error: unknown }>().error).toEqual(
      unknown.json<{ error: unknown }>().error,
    );
    expect(denied.statusCode).toBe(403);

    const competingPauses = await Promise.all([
      request(seller, 'POST', `${base}/pause`, {
        expectedControlRevision: approvedState!.controlRevision,
      }),
      request(seller, 'POST', `${base}/pause`, {
        expectedControlRevision: approvedState!.controlRevision,
      }),
    ]);
    expect(competingPauses.map((response) => response.statusCode).sort()).toEqual([200, 409]);

    const paused = competingPauses.find((response) => response.statusCode === 200);
    expect(paused).toBeDefined();
    const pausedListing = paused!.json<ControlResponse>().data.listing;
    expect(pausedListing).toMatchObject({
      status: 'approved',
      controlRevision: approvedState!.controlRevision + 1,
      approvedRevisionId: revisionId,
      archivedAt: null,
    });
    expect(pausedListing.pausedAt).not.toBeNull();

    const staleResume = await request(seller, 'POST', `${base}/resume`, {
      expectedControlRevision: approvedState!.controlRevision,
    });
    expect(staleResume.statusCode).toBe(409);

    const duplicatePause = await request(seller, 'POST', `${base}/pause`, {
      expectedControlRevision: pausedListing.controlRevision,
    });
    expect(duplicatePause.statusCode).toBe(409);

    const archived = await request(seller, 'POST', `${base}/archive`, {
      expectedControlRevision: pausedListing.controlRevision,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const archivedListing = archived.json<ControlResponse>().data.listing;
    expect(archivedListing).toMatchObject({
      status: 'approved',
      controlRevision: pausedListing.controlRevision + 1,
      approvedRevisionId: revisionId,
      pausedAt: pausedListing.pausedAt,
    });
    expect(archivedListing.archivedAt).not.toBeNull();

    const duplicateArchive = await request(seller, 'POST', `${base}/archive`, {
      expectedControlRevision: archivedListing.controlRevision,
    });
    expect(duplicateArchive.statusCode).toBe(409);

    const restored = await request(seller, 'POST', `${base}/restore`, {
      expectedControlRevision: archivedListing.controlRevision,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const restoredListing = restored.json<ControlResponse>().data.listing;
    expect(restoredListing).toMatchObject({
      status: 'approved',
      controlRevision: archivedListing.controlRevision + 1,
      approvedRevisionId: revisionId,
      pausedAt: pausedListing.pausedAt,
      archivedAt: null,
    });

    const resumed = await request(seller, 'POST', `${base}/resume`, {
      expectedControlRevision: restoredListing.controlRevision,
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    const resumedListing = resumed.json<ControlResponse>().data.listing;
    expect(resumedListing).toMatchObject({
      status: 'approved',
      controlRevision: restoredListing.controlRevision + 1,
      approvedRevisionId: revisionId,
      pausedAt: null,
      archivedAt: null,
    });

    const archiveAgain = await request(seller, 'POST', `${base}/archive`, {
      expectedControlRevision: resumedListing.controlRevision,
    });
    expect(archiveAgain.statusCode, archiveAgain.body).toBe(200);
    const archivedAgain = archiveAgain.json<ControlResponse>().data.listing;

    await getDatabase()
      .db.update(sellerListings)
      .set({
        administratorRemovedAt: new Date(),
        controlRevision: archivedAgain.controlRevision + 1,
      })
      .where(eq(sellerListings.id, prepared.listing.id));

    const restoreRemoved = await request(seller, 'POST', `${base}/restore`, {
      expectedControlRevision: archivedAgain.controlRevision + 1,
    });
    expect(restoreRemoved.statusCode).toBe(409);

    const [revision] = await getDatabase()
      .db.select()
      .from(sellerListingRevisions)
      .where(eq(sellerListingRevisions.id, revisionId));
    const [image] = await getDatabase()
      .db.select()
      .from(sellerListingImages)
      .where(eq(sellerListingImages.id, prepared.imageId));
    expect(revision).toBeDefined();
    expect(image).toBeDefined();
    expect(await getFileStore().isStored(image!.storageKey)).toBe(true);
  });

  it('archives and restores a pending submission without cancelling it or changing its draft', async () => {
    type ControlResponse = {
      data: {
        listing: Pick<
          ListingResponse['data']['listing'],
          'status' | 'controlRevision' | 'approvedRevisionId' | 'pausedAt' | 'archivedAt'
        >;
      };
    };

    const seller = await createSeller();
    const prepared = await createCompleteDraft(seller);
    const submitted = await request(
      seller,
      'POST',
      `/api/v1/seller/listings/${prepared.listing.id}/submit`,
      { expectedDraftRevision: prepared.draftRevision },
    );
    expect(submitted.statusCode, submitted.body).toBe(200);
    const revisionId = submitted.json<SubmissionResponse>().data.pendingSubmission.id;

    const [beforeArchive] = await getDatabase()
      .db.select({ controlRevision: sellerListings.controlRevision })
      .from(sellerListings)
      .where(eq(sellerListings.id, prepared.listing.id));
    const base = `/api/v1/seller/listings/${prepared.listing.id}`;

    const archived = await request(seller, 'POST', `${base}/archive`, {
      expectedControlRevision: beforeArchive!.controlRevision,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const archivedListing = archived.json<ControlResponse>().data.listing;
    expect(archivedListing).toMatchObject({
      status: 'submitted',
      controlRevision: beforeArchive!.controlRevision + 1,
      approvedRevisionId: null,
      pausedAt: null,
    });
    expect(archivedListing.archivedAt).not.toBeNull();

    const [draft] = await getDatabase()
      .db.select({ revision: sellerListingDrafts.revision })
      .from(sellerListingDrafts)
      .where(eq(sellerListingDrafts.listingId, prepared.listing.id));
    const [revision] = await getDatabase()
      .db.select({ id: sellerListingRevisions.id })
      .from(sellerListingRevisions)
      .where(eq(sellerListingRevisions.id, revisionId));
    expect(draft?.revision).toBe(prepared.draftRevision);
    expect(revision?.id).toBe(revisionId);

    const restored = await request(seller, 'POST', `${base}/restore`, {
      expectedControlRevision: archivedListing.controlRevision,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json<ControlResponse>().data.listing).toMatchObject({
      status: 'submitted',
      approvedRevisionId: null,
      pausedAt: null,
      archivedAt: null,
    });
  });

  it('does not restore an archived listing after Seller access is suspended', async () => {
    const seller = await createSeller();
    const prepared = await createCompleteDraft(seller);

    const submitted = await request(
      seller,
      'POST',
      `/api/v1/seller/listings/${prepared.listing.id}/submit`,
      { expectedDraftRevision: prepared.draftRevision },
    );
    expect(submitted.statusCode, submitted.body).toBe(200);

    const [beforeArchive] = await getDatabase()
      .db.select({ controlRevision: sellerListings.controlRevision })
      .from(sellerListings)
      .where(eq(sellerListings.id, prepared.listing.id));
    expect(beforeArchive).toBeDefined();

    const base = `/api/v1/seller/listings/${prepared.listing.id}`;
    const archived = await request(seller, 'POST', `${base}/archive`, {
      expectedControlRevision: beforeArchive!.controlRevision,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    const archivedListing = archived.json<{
      data: { listing: { controlRevision: number; archivedAt: string | null } };
    }>().data.listing;
    expect(archivedListing.archivedAt).not.toBeNull();

    await getDatabase()
      .db.update(sellerOperatingAccess)
      .set({ status: 'suspended', updatedAt: new Date() })
      .where(eq(sellerOperatingAccess.userId, seller.id));

    const restore = await request(seller, 'POST', `${base}/restore`, {
      expectedControlRevision: archivedListing.controlRevision,
    });
    expect(restore.statusCode).toBe(403);

    const [afterRestoreAttempt] = await getDatabase()
      .db.select({
        controlRevision: sellerListings.controlRevision,
        archivedAt: sellerListings.archivedAt,
      })
      .from(sellerListings)
      .where(eq(sellerListings.id, prepared.listing.id));

    expect(afterRestoreAttempt?.controlRevision).toBe(archivedListing.controlRevision);
    expect(afterRestoreAttempt?.archivedAt).toEqual(new Date(archivedListing.archivedAt!));
  });

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
      override async isStored(): Promise<boolean> {
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

  it('rejects an incomplete submission without changing the draft or creating a revision', async () => {
    const seller = await createSeller();
    const listing = await createListing(seller);

    const response = await request(seller, 'POST', `/api/v1/seller/listings/${listing.id}/submit`, {
      expectedDraftRevision: listing.draft!.revision,
    });

    expect(response.statusCode, response.body).toBe(400);
    const body = response.json<{
      error: {
        code: string;
        details: Array<{ code: string; path: string; message: string }>;
      };
    }>();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.map((issue) => issue.path)).toContain('title');
    expect(body.error.details.map((issue) => issue.code)).toContain('title_required');

    const [currentListing] = await getDatabase()
      .db.select({ status: sellerListings.status })
      .from(sellerListings)
      .where(eq(sellerListings.id, listing.id));
    const revisions = await getDatabase()
      .db.select({ id: sellerListingRevisions.id })
      .from(sellerListingRevisions)
      .where(eq(sellerListingRevisions.listingId, listing.id));

    expect(currentListing?.status).toBe('draft');
    expect(revisions).toHaveLength(0);
  });

  it('seals a complete revision, preserves an approved pointer, and rejects repeated or foreign submissions', async () => {
    const seller = await createSeller();
    const otherSeller = await createSeller();
    const prepared = await createCompleteDraft(seller);

    // Model a listing with a prior approved revision. Submission must leave
    // this pointer alone while its new revision awaits review.
    const [previousApproved] = await getDatabase()
      .db.insert(sellerListingRevisions)
      .values({
        listingId: prepared.listing.id,
        revision: 1,
        catalogProductId,
        submittedByUserId: seller.id,
        title: 'Previously approved synthetic listing',
        description: 'Historical approved content.',
        condition: 'new',
      })
      .returning({ id: sellerListingRevisions.id });

    expect(previousApproved).toBeDefined();
    await getDatabase()
      .db.insert(sellerListingApprovedRevisions)
      .values({ listingId: prepared.listing.id, revisionId: previousApproved!.id });

    const foreign = await request(
      otherSeller,
      'POST',
      `/api/v1/seller/listings/${prepared.listing.id}/submit`,
      { expectedDraftRevision: prepared.draftRevision },
    );
    expect(foreign.statusCode).toBe(404);

    const submitted = await request(
      seller,
      'POST',
      `/api/v1/seller/listings/${prepared.listing.id}/submit`,
      { expectedDraftRevision: prepared.draftRevision },
    );

    expect(submitted.statusCode, submitted.body).toBe(200);
    const submission = submitted.json<SubmissionResponse>().data;
    expect(submission).toMatchObject({
      listingId: prepared.listing.id,
      status: 'submitted',
      approvedRevisionId: previousApproved!.id,
      pendingSubmission: { revision: prepared.draftRevision },
    });

    const [sealedRevision] = await getDatabase()
      .db.select()
      .from(sellerListingRevisions)
      .where(eq(sellerListingRevisions.id, submission.pendingSubmission.id));

    expect(sealedRevision).toMatchObject({
      listingId: prepared.listing.id,
      revision: prepared.draftRevision,
      catalogProductId,
      submittedByUserId: seller.id,
      title: prepared.listing.draft!.title,
      condition: 'new',
    });
    expect(sealedRevision?.catalogSnapshot).toMatchObject({
      product: { id: catalogProductId },
      configurations: [
        {
          catalogVariantId,
          sellableVariantId: prepared.sellableVariantId,
          isDefault: true,
        },
      ],
    });
    expect(JSON.stringify(sealedRevision?.catalogSnapshot)).not.toContain('priceXaf');
    expect(JSON.stringify(sealedRevision?.catalogSnapshot)).not.toContain('stockQuantity');
    expect(JSON.stringify(sealedRevision?.catalogSnapshot)).not.toContain('"sku"');

    const configurationRows = await getDatabase()
      .db.select()
      .from(sellerListingRevisionConfigurations)
      .where(eq(sellerListingRevisionConfigurations.revisionId, submission.pendingSubmission.id));
    const offerRows = await getDatabase()
      .db.select()
      .from(sellerListingRevisionOffers)
      .where(eq(sellerListingRevisionOffers.revisionId, submission.pendingSubmission.id));
    const imageRows = await getDatabase()
      .db.select()
      .from(sellerListingRevisionImages)
      .where(eq(sellerListingRevisionImages.revisionId, submission.pendingSubmission.id));

    expect(configurationRows.map((row) => row.catalogVariantId)).toEqual([catalogVariantId]);
    expect(offerRows.map((row) => row.sellerListingVariantId)).toEqual([
      prepared.sellableVariantId,
    ]);
    expect(imageRows).toHaveLength(1);
    expect(imageRows[0]?.imageId).toBe(prepared.imageId);

    const stale = await request(
      seller,
      'POST',
      `/api/v1/seller/listings/${prepared.listing.id}/submit`,
      { expectedDraftRevision: prepared.draftRevision - 1 },
    );
    const repeated = await request(
      seller,
      'POST',
      `/api/v1/seller/listings/${prepared.listing.id}/submit`,
      { expectedDraftRevision: prepared.draftRevision },
    );
    const editAfterSubmission = await request(
      seller,
      'PATCH',
      `/api/v1/seller/listings/${prepared.listing.id}/draft`,
      { expectedDraftRevision: prepared.draftRevision, title: 'Must remain read-only' },
    );

    expect(stale.statusCode).toBe(409);
    expect(repeated.statusCode).toBe(409);
    expect(editAfterSubmission.statusCode).toBe(409);

    const detail = await request(seller, 'GET', `/api/v1/seller/listings/${prepared.listing.id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<ListingWorkflowDetailResponse>().data.listing).toMatchObject({
      status: 'submitted',
      approvedRevisionId: previousApproved!.id,
      pendingSubmission: {
        revisionId: submission.pendingSubmission.id,
        revision: prepared.draftRevision,
      },
      latestReviewOutcome: null,
    });
  });

  it('copies the current approved revision into a replacement draft without changing published history', async () => {
    const seller = await createSeller();
    const prepared = await createCompleteDraft(seller);

    const submitted = await request(
      seller,
      'POST',
      `/api/v1/seller/listings/${prepared.listing.id}/submit`,
      { expectedDraftRevision: prepared.draftRevision },
    );
    expect(submitted.statusCode, submitted.body).toBe(200);

    const submission = submitted.json<SubmissionResponse>().data;
    const approvedRevisionId = submission.pendingSubmission.id;

    const [revisionBefore] = await getDatabase()
      .db.select()
      .from(sellerListingRevisions)
      .where(eq(sellerListingRevisions.id, approvedRevisionId));

    const configurationsBefore = await getDatabase()
      .db.select()
      .from(sellerListingRevisionConfigurations)
      .where(eq(sellerListingRevisionConfigurations.revisionId, approvedRevisionId));

    const offersBefore = await getDatabase()
      .db.select()
      .from(sellerListingRevisionOffers)
      .where(eq(sellerListingRevisionOffers.revisionId, approvedRevisionId));

    const imagesBefore = await getDatabase()
      .db.select()
      .from(sellerListingRevisionImages)
      .where(eq(sellerListingRevisionImages.revisionId, approvedRevisionId));

    const [listingBeforeApproval] = await getDatabase()
      .db.select({
        controlRevision: sellerListings.controlRevision,
      })
      .from(sellerListings)
      .where(eq(sellerListings.id, prepared.listing.id));

    await getDatabase()
      .db.update(sellerListings)
      .set({
        status: 'approved',
        controlRevision: listingBeforeApproval!.controlRevision + 1,
      })
      .where(eq(sellerListings.id, prepared.listing.id));

    await getDatabase().db.insert(sellerListingApprovedRevisions).values({
      listingId: prepared.listing.id,
      revisionId: approvedRevisionId,
    });

    const [listingBeforeDraft] = await getDatabase()
      .db.select({ controlRevision: sellerListings.controlRevision })
      .from(sellerListings)
      .where(eq(sellerListings.id, prepared.listing.id));

    const created = await request(
      seller,
      'POST',
      `/api/v1/seller/listings/${prepared.listing.id}/draft`,
      {
        sourceApprovedRevisionId: approvedRevisionId,
        expectedControlRevision: listingBeforeDraft!.controlRevision,
      },
    );

    expect(created.statusCode, created.body).toBe(200);

    const listing = created.json<ListingResponse>().data.listing;
    expect(listing).toMatchObject({
      status: 'draft',
      controlRevision: listingBeforeDraft!.controlRevision + 1,
      approvedRevisionId,
      draft: {
        revision: submission.pendingSubmission.revision + 1,
        catalogProductId,
        catalogVariantIds: [catalogVariantId],
        title: prepared.listing.draft!.title,
        condition: 'new',
      },
    });

    const [revisionAfter] = await getDatabase()
      .db.select()
      .from(sellerListingRevisions)
      .where(eq(sellerListingRevisions.id, approvedRevisionId));

    const configurationsAfter = await getDatabase()
      .db.select()
      .from(sellerListingRevisionConfigurations)
      .where(eq(sellerListingRevisionConfigurations.revisionId, approvedRevisionId));

    const offersAfter = await getDatabase()
      .db.select()
      .from(sellerListingRevisionOffers)
      .where(eq(sellerListingRevisionOffers.revisionId, approvedRevisionId));

    const imagesAfter = await getDatabase()
      .db.select()
      .from(sellerListingRevisionImages)
      .where(eq(sellerListingRevisionImages.revisionId, approvedRevisionId));

    expect(revisionAfter).toEqual(revisionBefore);
    expect(configurationsAfter).toEqual(configurationsBefore);
    expect(offersAfter).toEqual(offersBefore);
    expect(imagesAfter).toEqual(imagesBefore);

    const draftImages = await getDatabase()
      .db.select()
      .from(sellerListingDraftImages)
      .where(eq(sellerListingDraftImages.listingId, prepared.listing.id));

    expect(draftImages).toMatchObject([
      {
        imageId: prepared.imageId,
        variantId: null,
        sortOrder: 0,
        isCover: true,
      },
    ]);

    const [storedImage] = await getDatabase()
      .db.select()
      .from(sellerListingImages)
      .where(eq(sellerListingImages.id, prepared.imageId));

    expect(storedImage).toBeDefined();
    expect(await getFileStore().isStored(storedImage!.storageKey)).toBe(true);

    const stalePointer = await request(
      seller,
      'POST',
      `/api/v1/seller/listings/${prepared.listing.id}/draft`,
      {
        sourceApprovedRevisionId: randomUUID(),
        expectedControlRevision: listing.controlRevision,
      },
    );
    expect(stalePointer.statusCode).toBe(409);

    const duplicate = await request(
      seller,
      'POST',
      `/api/v1/seller/listings/${prepared.listing.id}/draft`,
      {
        sourceApprovedRevisionId: approvedRevisionId,
        expectedControlRevision: listing.controlRevision,
      },
    );
    expect(duplicate.statusCode).toBe(409);
  });

  it('copies a reviewed revision to a new draft and retains its files and outcome history', async () => {
    const seller = await createSeller();
    const reviewer = await createSeller();
    const prepared = await createCompleteDraft(seller);
    const submitted = await request(
      seller,
      'POST',
      `/api/v1/seller/listings/${prepared.listing.id}/submit`,
      { expectedDraftRevision: prepared.draftRevision },
    );
    expect(submitted.statusCode, submitted.body).toBe(200);
    const submission = submitted.json<SubmissionResponse>().data;

    const [listingBeforeReview] = await getDatabase()
      .db.select({ controlRevision: sellerListings.controlRevision })
      .from(sellerListings)
      .where(eq(sellerListings.id, prepared.listing.id));

    await getDatabase().db.insert(sellerListingReviewOutcomes).values({
      listingId: prepared.listing.id,
      revisionId: submission.pendingSubmission.id,
      decision: 'changes_requested',
      reviewerUserId: reviewer.id,
      feedback: 'Please clarify the listing description.',
    });
    await getDatabase()
      .db.update(sellerListings)
      .set({
        status: 'changes_requested',
        controlRevision: listingBeforeReview!.controlRevision + 1,
      })
      .where(eq(sellerListings.id, prepared.listing.id));

    const reviewDetail = await request(
      seller,
      'GET',
      `/api/v1/seller/listings/${prepared.listing.id}`,
    );
    expect(reviewDetail.statusCode, reviewDetail.body).toBe(200);
    expect(reviewDetail.json<ListingWorkflowDetailResponse>().data.listing).toMatchObject({
      status: 'changes_requested',
      pendingSubmission: null,
      latestReviewOutcome: {
        revisionId: submission.pendingSubmission.id,
        decision: 'changes_requested',
        feedback: 'Please clarify the listing description.',
      },
    });

    const [listingForCorrection] = await getDatabase()
      .db.select({ controlRevision: sellerListings.controlRevision })
      .from(sellerListings)
      .where(eq(sellerListings.id, prepared.listing.id));
    const correctionUrl = `/api/v1/seller/listings/${prepared.listing.id}/draft`;

    const foreign = await request(reviewer, 'POST', correctionUrl, {
      sourceRevisionId: submission.pendingSubmission.id,
      expectedControlRevision: listingForCorrection!.controlRevision,
    });
    const stale = await request(seller, 'POST', correctionUrl, {
      sourceRevisionId: submission.pendingSubmission.id,
      expectedControlRevision: listingForCorrection!.controlRevision - 1,
    });
    expect(foreign.statusCode).toBe(404);
    expect(stale.statusCode).toBe(409);

    const createdDraft = await request(seller, 'POST', correctionUrl, {
      sourceRevisionId: submission.pendingSubmission.id,
      expectedControlRevision: listingForCorrection!.controlRevision,
    });
    expect(createdDraft.statusCode, createdDraft.body).toBe(200);
    expect(createdDraft.json<ListingResponse>().data.listing).toMatchObject({
      status: 'draft',
      draft: {
        revision: prepared.draftRevision + 1,
        catalogProductId,
        catalogVariantIds: [catalogVariantId],
        title: prepared.listing.draft!.title,
        condition: 'new',
      },
    });

    const duplicateDraft = await request(seller, 'POST', correctionUrl, {
      sourceRevisionId: submission.pendingSubmission.id,
      expectedControlRevision: listingForCorrection!.controlRevision + 1,
    });
    expect(duplicateDraft.statusCode).toBe(409);

    const copiedDraftImages = await getDatabase()
      .db.select()
      .from(sellerListingDraftImages)
      .where(eq(sellerListingDraftImages.listingId, prepared.listing.id));
    const [imageRecord] = await getDatabase()
      .db.select()
      .from(sellerListingImages)
      .where(eq(sellerListingImages.id, prepared.imageId));

    expect(copiedDraftImages).toMatchObject([
      { imageId: prepared.imageId, variantId: null, sortOrder: 0, isCover: true },
    ]);
    expect(imageRecord).toBeDefined();
    expect(await getFileStore().isStored(imageRecord!.storageKey)).toBe(true);

    const edited = await request(seller, 'PATCH', correctionUrl, {
      expectedDraftRevision: prepared.draftRevision + 1,
      title: 'Corrected synthetic listing',
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const correctedRevision = edited.json<ListingResponse>().data.listing.draft!.revision;

    const resubmitted = await request(
      seller,
      'POST',
      `/api/v1/seller/listings/${prepared.listing.id}/submit`,
      { expectedDraftRevision: correctedRevision },
    );
    expect(resubmitted.statusCode, resubmitted.body).toBe(200);
    expect(resubmitted.json<SubmissionResponse>().data.pendingSubmission.revision).toBe(
      correctedRevision,
    );

    const history = await getDatabase()
      .db.select({ revision: sellerListingRevisions.revision })
      .from(sellerListingRevisions)
      .where(eq(sellerListingRevisions.listingId, prepared.listing.id))
      .orderBy(sellerListingRevisions.revision);
    expect(history.map((row) => row.revision)).toEqual([prepared.draftRevision, correctedRevision]);

    const retainedOutcome = await getDatabase()
      .db.select({ decision: sellerListingReviewOutcomes.decision })
      .from(sellerListingReviewOutcomes)
      .where(eq(sellerListingReviewOutcomes.revisionId, submission.pendingSubmission.id));
    expect(retainedOutcome[0]?.decision).toBe('changes_requested');
  });

  it('starts a correction draft from a rejected revision without changing its history', async () => {
    const seller = await createSeller();
    const reviewer = await createSeller();
    const prepared = await createCompleteDraft(seller);

    const submitted = await request(
      seller,
      'POST',
      `/api/v1/seller/listings/${prepared.listing.id}/submit`,
      { expectedDraftRevision: prepared.draftRevision },
    );
    expect(submitted.statusCode, submitted.body).toBe(200);
    const submission = submitted.json<SubmissionResponse>().data;

    const [beforeReview] = await getDatabase()
      .db.select({ controlRevision: sellerListings.controlRevision })
      .from(sellerListings)
      .where(eq(sellerListings.id, prepared.listing.id));

    await getDatabase().db.insert(sellerListingReviewOutcomes).values({
      listingId: prepared.listing.id,
      revisionId: submission.pendingSubmission.id,
      decision: 'rejected',
      reviewerUserId: reviewer.id,
      feedback: 'The submitted product information cannot be approved.',
    });
    await getDatabase()
      .db.update(sellerListings)
      .set({
        status: 'rejected',
        controlRevision: beforeReview!.controlRevision + 1,
      })
      .where(eq(sellerListings.id, prepared.listing.id));

    const [rejectedRevisionBefore] = await getDatabase()
      .db.select({
        title: sellerListingRevisions.title,
        submittedAt: sellerListingRevisions.submittedAt,
      })
      .from(sellerListingRevisions)
      .where(eq(sellerListingRevisions.id, submission.pendingSubmission.id));
    const [currentListing] = await getDatabase()
      .db.select({ controlRevision: sellerListings.controlRevision })
      .from(sellerListings)
      .where(eq(sellerListings.id, prepared.listing.id));

    const correction = await request(
      seller,
      'POST',
      `/api/v1/seller/listings/${prepared.listing.id}/draft`,
      {
        sourceRevisionId: submission.pendingSubmission.id,
        expectedControlRevision: currentListing!.controlRevision,
      },
    );

    expect(correction.statusCode, correction.body).toBe(200);
    expect(correction.json<ListingResponse>().data.listing).toMatchObject({
      status: 'draft',
      draft: {
        revision: prepared.draftRevision + 1,
        title: prepared.listing.draft!.title,
        catalogProductId,
        catalogVariantIds: [catalogVariantId],
      },
    });

    const [rejectedRevisionAfter] = await getDatabase()
      .db.select({
        title: sellerListingRevisions.title,
        submittedAt: sellerListingRevisions.submittedAt,
      })
      .from(sellerListingRevisions)
      .where(eq(sellerListingRevisions.id, submission.pendingSubmission.id));
    expect(rejectedRevisionAfter).toEqual(rejectedRevisionBefore);

    const detail = await request(seller, 'GET', `/api/v1/seller/listings/${prepared.listing.id}`);
    expect(
      detail.json<ListingWorkflowDetailResponse>().data.listing.latestReviewOutcome,
    ).toMatchObject({
      revisionId: submission.pendingSubmission.id,
      decision: 'rejected',
      feedback: 'The submitted product information cannot be approved.',
    });
  });

  it('allows only one concurrent submission for the same draft revision', async () => {
    const seller = await createSeller();
    const prepared = await createCompleteDraft(seller);
    const url = `/api/v1/seller/listings/${prepared.listing.id}/submit`;

    const responses = await Promise.all([
      request(seller, 'POST', url, { expectedDraftRevision: prepared.draftRevision }),
      request(seller, 'POST', url, { expectedDraftRevision: prepared.draftRevision }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);

    const revisions = await getDatabase()
      .db.select({ revision: sellerListingRevisions.revision })
      .from(sellerListingRevisions)
      .where(eq(sellerListingRevisions.listingId, prepared.listing.id));
    expect(revisions).toHaveLength(1);
  });

  it('serializes a draft edit against submission without losing either operation silently', async () => {
    const seller = await createSeller();
    const prepared = await createCompleteDraft(seller);
    const listingUrl = `/api/v1/seller/listings/${prepared.listing.id}`;

    const [edit, submit] = await Promise.all([
      request(seller, 'PATCH', `${listingUrl}/draft`, {
        expectedDraftRevision: prepared.draftRevision,
        title: 'Concurrent edit wins only if submission has not sealed the draft',
      }),
      request(seller, 'POST', `${listingUrl}/submit`, {
        expectedDraftRevision: prepared.draftRevision,
      }),
    ]);

    expect([edit.statusCode, submit.statusCode].filter((status) => status === 200)).toHaveLength(1);
    expect([edit.statusCode, submit.statusCode].filter((status) => status === 409)).toHaveLength(1);

    const [current] = await getDatabase()
      .db.select({ status: sellerListings.status })
      .from(sellerListings)
      .where(eq(sellerListings.id, prepared.listing.id));
    const revisions = await getDatabase()
      .db.select({ revision: sellerListingRevisions.revision })
      .from(sellerListingRevisions)
      .where(eq(sellerListingRevisions.listingId, prepared.listing.id));

    if (submit.statusCode === 200) {
      expect(current?.status).toBe('submitted');
      expect(edit.statusCode).toBe(409);
      expect(revisions).toHaveLength(1);
    } else {
      expect(current?.status).toBe('draft');
      expect(submit.statusCode).toBe(409);
      expect(revisions).toHaveLength(0);
    }
  });
});
