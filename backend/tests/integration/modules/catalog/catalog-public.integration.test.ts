import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../../src/app.js';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../src/infrastructure/database/client.js';
import { identityUserPermissions } from '../../../../src/modules/identity/accounts/permission.table.js';
import { identityUsers } from '../../../../src/modules/identity/accounts/user.table.js';
import { createSession } from '../../../../src/modules/identity/sessions/session.service.js';
import { identitySessions } from '../../../../src/modules/identity/sessions/session.table.js';
import { catalogBrands } from '../../../../src/modules/catalog/brand.table.js';
import { catalogCategories } from '../../../../src/modules/catalog/category.table.js';
import { catalogProducts } from '../../../../src/modules/catalog/product.table.js';
import { catalogVariants } from '../../../../src/modules/catalog/variant.table.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../helpers/test-database.js';

const runId = randomUUID();
const userIds: string[] = [];
const categoryIds: string[] = [];
const brandIds: string[] = [];
const productIds: string[] = [];

let sequence = 0;
let database: DatabaseClient | undefined;
let appDatabase: DatabaseClient | undefined;
let app: FastifyInstance | undefined;
let testDatabaseVerified = false;

interface AdminFixture {
  id: string;
  token: string;
}

interface PublicCategory {
  id: string;
  slug: string;
  name: string;
  imageUrl: string | null;
  attributeRuleSetKey: string;
  attributeRules: Array<{
    key: string;
    label: string;
    type: string;
    required: boolean;
    variantAllowed: boolean;
    allowedValues?: Array<string | number>;
    unit?: string;
    requiredWhen: Array<{ field: string; equals: string | number }>;
  }>;
}

interface PublicBrand {
  id: string;
  slug: string;
  name: string;
  imageUrl: string | null;
}

interface PublicProductWithVariants {
  product: {
    id: string;
    name: string;
    description: string | null;
    category: PublicCategory;
    brand: PublicBrand | null;
    fixedAttributes: Record<string, unknown>;
    variantOptionKeys: string[];
    [key: string]: unknown;
  };
  variants: Array<{
    id: string;
    optionValues: Record<string, unknown>;
    isDefault: boolean;
    [key: string]: unknown;
  }>;
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

async function createAdmin(): Promise<AdminFixture> {
  sequence += 1;
  const email = `catalog-public-${runId}-${sequence}@example.test`;

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
    throw new Error('Could not create public catalog test account.');
  }

  userIds.push(user.id);

  await getDatabase().db.insert(identityUserPermissions).values({
    userId: user.id,
    permission: 'administrator',
  });

  const session = await createSession(getDatabase().db, user.id);

  if (!session) {
    throw new Error('Could not create public catalog test session.');
  }

  await getDatabase()
    .db.update(identitySessions)
    .set({
      adminMfaElevatedAt: new Date(Date.now() - 5_000),
      adminMfaElevatedUntil: new Date(Date.now() + 10 * 60_000),
    })
    .where(eq(identitySessions.id, session.sessionId));

  return { id: user.id, token: session.rawToken };
}

function request(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  token?: string,
  payload?: Record<string, unknown>,
) {
  return getApp().inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload === undefined ? {} : { payload }),
  });
}

async function createCategory(adminToken: string, ruleSetKey: string): Promise<PublicCategory> {
  sequence += 1;

  const response = await request('POST', '/api/v1/admin/catalog/categories', adminToken, {
    slug: `public-test-${runId}-${sequence}`,
    name: `Public test category ${sequence}`,
    attributeRuleSetKey: ruleSetKey,
  });

  expect(response.statusCode, response.body).toBe(201);
  const category = response.json<{ data: { category: PublicCategory } }>().data.category;
  categoryIds.push(category.id);
  return category;
}

async function createBrand(adminToken: string): Promise<PublicBrand> {
  sequence += 1;

  const response = await request('POST', '/api/v1/admin/catalog/brands', adminToken, {
    slug: `public-test-${runId}-${sequence}`,
    name: `Public test brand ${sequence}`,
  });

  expect(response.statusCode, response.body).toBe(201);
  const brand = response.json<{ data: { brand: PublicBrand } }>().data.brand;
  brandIds.push(brand.id);
  return brand;
}

async function createProduct(
  adminToken: string,
  input: {
    categoryId: string;
    brandId: string | null;
    name: string;
    isVisible: boolean;
    fixedAttributes?: Record<string, unknown>;
    variantOptionKeys?: string[];
    variants?: Array<{ optionValues: Record<string, unknown> }>;
  },
): Promise<{ product: { id: string }; variants: Array<{ id: string }> }> {
  const response = await request('POST', '/api/v1/admin/catalog/products', adminToken, {
    ...input,
    description: `Synthetic description for ${input.name}`,
  });

  expect(response.statusCode, response.body).toBe(201);
  const result = response.json<{
    data: { product: { id: string }; variants: Array<{ id: string }> };
  }>().data;
  productIds.push(result.product.id);
  return result;
}

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(database.pool);
  testDatabaseVerified = true;

  appDatabase = createDatabaseClient(requireTestDatabaseUrl(process.env));
  await verifyTestDatabaseIdentity(appDatabase.pool);

  app = buildApp({ database: appDatabase });
});

afterAll(async () => {
  try {
    await app?.close();

    if (database && testDatabaseVerified) {
      if (productIds.length > 0) {
        await database.db.delete(catalogProducts).where(inArray(catalogProducts.id, productIds));
      }

      if (categoryIds.length > 0) {
        await database.db
          .delete(catalogCategories)
          .where(inArray(catalogCategories.id, categoryIds));
      }

      if (brandIds.length > 0) {
        await database.db.delete(catalogBrands).where(inArray(catalogBrands.id, brandIds));
      }

      if (userIds.length > 0) {
        await database.db.delete(identityUsers).where(inArray(identityUsers.id, userIds));
      }
    }
  } finally {
    await Promise.allSettled([database?.close(), appDatabase?.close()]);
  }
});

describe('public catalog routes', () => {
  it('serves active categories and brands without authentication and reflects Admin image updates', async () => {
    const admin = await createAdmin();
    const category = await createCategory(admin.token, 'tennis_shoes');
    const accessoryCategory = await createCategory(admin.token, 'racquet_accessories');
    const brand = await createBrand(admin.token);

    const initialCategories = await request('GET', '/api/v1/catalog/categories');
    const initialBrands = await request('GET', '/api/v1/catalog/brands');

    expect(initialCategories.statusCode, initialCategories.body).toBe(200);
    expect(initialBrands.statusCode, initialBrands.body).toBe(200);

    const initialCategoryItems = initialCategories.json<{ data: { items: PublicCategory[] } }>()
      .data.items;
    const initialBrandItems = initialBrands.json<{ data: { items: PublicBrand[] } }>().data.items;

    expect(initialCategoryItems.find((item) => item.id === category.id)?.imageUrl).toBeNull();
    expect(initialBrandItems.find((item) => item.id === brand.id)?.imageUrl).toBeNull();

    const shoeRules = initialCategoryItems.find((item) => item.id === category.id)?.attributeRules;
    expect(shoeRules?.find((rule) => rule.key === 'euSize')).toMatchObject({
      required: true,
      variantAllowed: true,
      unit: 'EU',
    });
    expect(shoeRules?.find((rule) => rule.key === 'courtSurface')).toMatchObject({
      required: true,
      variantAllowed: false,
      allowedValues: ['hard_court', 'clay_court', 'all_court'],
    });

    const accessoryRules = initialCategoryItems.find(
      (item) => item.id === accessoryCategory.id,
    )?.attributeRules;
    const compatibilityRules = accessoryRules?.filter(
      (rule) => rule.key === 'compatibleRacquetModels',
    );

    expect(compatibilityRules).toHaveLength(1);
    expect(compatibilityRules?.[0]?.requiredWhen).toEqual([
      { field: 'accessoryType', equals: 'grommet_set' },
      { field: 'accessoryType', equals: 'bumper_guard' },
      { field: 'accessoryType', equals: 'model_specific_other' },
    ]);

    const categoryImage = `https://images.example.test/${runId}/category.png`;
    const brandImage = `https://images.example.test/${runId}/brand.png`;

    const updateCategory = await request(
      'PATCH',
      `/api/v1/admin/catalog/categories/${category.id}`,
      admin.token,
      { imageUrl: categoryImage },
    );
    const updateBrand = await request(
      'PATCH',
      `/api/v1/admin/catalog/brands/${brand.id}`,
      admin.token,
      { imageUrl: brandImage },
    );

    expect(updateCategory.statusCode, updateCategory.body).toBe(200);
    expect(updateBrand.statusCode, updateBrand.body).toBe(200);

    const updatedCategories = await request('GET', '/api/v1/catalog/categories');
    const updatedBrands = await request('GET', '/api/v1/catalog/brands');

    expect(
      updatedCategories
        .json<{ data: { items: PublicCategory[] } }>()
        .data.items.find((item) => item.id === category.id)?.imageUrl,
    ).toBe(categoryImage);
    expect(
      updatedBrands
        .json<{ data: { items: PublicBrand[] } }>()
        .data.items.find((item) => item.id === brand.id)?.imageUrl,
    ).toBe(brandImage);
  });

  it('filters and paginates visible products, exposes Unbranded and variants, and hides inactive choices', async () => {
    const admin = await createAdmin();
    const category = await createCategory(admin.token, 'tennis_racquets');
    const brand = await createBrand(admin.token);

    const unbranded = await createProduct(admin.token, {
      categoryId: category.id,
      brandId: null,
      name: `Unbranded ${runId}`,
      isVisible: true,
      fixedAttributes: {
        audience: 'adult',
        lengthInches: 27,
        gripSize: 'L2',
      },
    });

    const branded = await createProduct(admin.token, {
      categoryId: category.id,
      brandId: brand.id,
      name: `Branded ${runId}`,
      isVisible: true,
      fixedAttributes: {
        audience: 'adult',
        lengthInches: 27,
      },
      variantOptionKeys: ['gripSize'],
      variants: [{ optionValues: { gripSize: 'L2' } }, { optionValues: { gripSize: 'L3' } }],
    });

    const hidden = await createProduct(admin.token, {
      categoryId: category.id,
      brandId: brand.id,
      name: `Hidden ${runId}`,
      isVisible: false,
      fixedAttributes: {
        audience: 'adult',
        lengthInches: 27,
        gripSize: 'L4',
      },
    });

    const categoryPage = await request(
      'GET',
      `/api/v1/catalog/products?categoryId=${category.id}&limit=1&offset=0`,
    );
    const nextCategoryPage = await request(
      'GET',
      `/api/v1/catalog/products?categoryId=${category.id}&limit=1&offset=1`,
    );
    const brandPage = await request(
      'GET',
      `/api/v1/catalog/products?brandId=${brand.id}&limit=10&offset=0`,
    );
    const allVisible = await request(
      'GET',
      `/api/v1/catalog/products?categoryId=${category.id}&limit=10&offset=0`,
    );

    expect(categoryPage.statusCode, categoryPage.body).toBe(200);
    expect(nextCategoryPage.statusCode, nextCategoryPage.body).toBe(200);
    expect(brandPage.statusCode, brandPage.body).toBe(200);
    expect(allVisible.statusCode, allVisible.body).toBe(200);

    const firstPage = categoryPage.json<{
      data: { items: PublicProductWithVariants[]; limit: number; offset: number };
    }>().data;
    const secondPage = nextCategoryPage.json<{
      data: { items: PublicProductWithVariants[]; limit: number; offset: number };
    }>().data;
    const visibleItems = allVisible.json<{
      data: { items: PublicProductWithVariants[] };
    }>().data.items;
    const brandItems = brandPage.json<{
      data: { items: PublicProductWithVariants[] };
    }>().data.items;

    expect(firstPage).toMatchObject({ limit: 1, offset: 0 });
    expect(secondPage).toMatchObject({ limit: 1, offset: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(secondPage.items).toHaveLength(1);
    expect(firstPage.items[0]?.product.id).not.toBe(secondPage.items[0]?.product.id);
    expect(visibleItems).toHaveLength(2);
    expect(visibleItems.some((item) => item.product.id === hidden.product.id)).toBe(false);
    expect(brandItems).toHaveLength(1);
    expect(brandItems[0]?.product.id).toBe(branded.product.id);

    const unbrandedItem = visibleItems.find((item) => item.product.id === unbranded.product.id);
    const brandedItem = visibleItems.find((item) => item.product.id === branded.product.id);

    expect(unbrandedItem?.product.brand).toBeNull();
    expect(unbrandedItem?.variants).toHaveLength(1);
    expect(unbrandedItem?.variants[0]?.isDefault).toBe(true);
    expect(unbrandedItem?.variants[0]?.optionValues).toEqual({});

    expect(brandedItem?.product.brand).toMatchObject({
      id: brand.id,
      imageUrl: null,
    });
    expect(brandedItem?.variants).toHaveLength(2);
    expect(brandedItem?.product.variantOptionKeys).toEqual(['gripSize']);

    for (const item of visibleItems) {
      expect(item.product).not.toHaveProperty('isVisible');
      expect(item.product).not.toHaveProperty('createdAt');
      expect(item.product).not.toHaveProperty('updatedAt');
      for (const variant of item.variants) {
        expect(variant).not.toHaveProperty('optionSignature');
        expect(variant).not.toHaveProperty('productId');
        expect(variant).not.toHaveProperty('createdAt');
      }
    }

    const hiddenDetail = await request('GET', `/api/v1/catalog/products/${hidden.product.id}`);
    const unknownId = randomUUID();
    const unknownDetail = await request('GET', `/api/v1/catalog/products/${unknownId}`);

    expect(hiddenDetail.statusCode).toBe(404);
    expect(unknownDetail.statusCode).toBe(404);
    expect(hiddenDetail.json<{ error: unknown }>().error).toEqual(
      unknownDetail.json<{ error: unknown }>().error,
    );

    const deactivateCategory = await request(
      'PATCH',
      `/api/v1/admin/catalog/categories/${category.id}`,
      admin.token,
      { isActive: false },
    );
    const deactivateBrand = await request(
      'PATCH',
      `/api/v1/admin/catalog/brands/${brand.id}`,
      admin.token,
      { isActive: false },
    );

    expect(deactivateCategory.statusCode, deactivateCategory.body).toBe(200);
    expect(deactivateBrand.statusCode, deactivateBrand.body).toBe(200);

    const activeCategories = await request('GET', '/api/v1/catalog/categories');
    const activeBrands = await request('GET', '/api/v1/catalog/brands');
    const retainedProduct = await request('GET', `/api/v1/catalog/products/${branded.product.id}`);

    expect(
      activeCategories
        .json<{ data: { items: PublicCategory[] } }>()
        .data.items.some((item) => item.id === category.id),
    ).toBe(false);
    expect(
      activeBrands
        .json<{ data: { items: PublicBrand[] } }>()
        .data.items.some((item) => item.id === brand.id),
    ).toBe(false);

    expect(retainedProduct.statusCode, retainedProduct.body).toBe(200);
    expect(
      retainedProduct.json<{ data: PublicProductWithVariants }>().data.product.category,
    ).toMatchObject({
      id: category.id,
      slug: category.slug,
      imageUrl: null,
    });
    expect(
      retainedProduct.json<{ data: PublicProductWithVariants }>().data.product.brand,
    ).toMatchObject({
      id: brand.id,
      slug: brand.slug,
      imageUrl: null,
    });
  });

  it('rejects invalid query values using the API validation envelope', async () => {
    const response = await request('GET', '/api/v1/catalog/products?limit=101');

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string }; requestId: string }>().error.code).toBe(
      'VALIDATION_ERROR',
    );
    expect(response.json<{ requestId: string }>().requestId).toBe(response.headers['x-request-id']);
  });
});
