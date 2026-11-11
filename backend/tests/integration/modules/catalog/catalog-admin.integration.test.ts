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
import { seedCatalogLaunchData } from '../../../../src/modules/catalog/launch-data.js';
import { catalogVariants } from '../../../../src/modules/catalog/variant.table.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../helpers/test-database.js';

const runId = randomUUID();
const userIds: string[] = [];
const customCategoryIds: string[] = [];
const customBrandIds: string[] = [];
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

interface CategoryData {
  id: string;
  slug: string;
  name: string;
  imageUrl: string | null;
  attributeRuleSetKey: string;
  isActive: boolean;
}

interface BrandData {
  id: string;
  slug: string;
  name: string;
  imageUrl: string | null;
  isActive: boolean;
}

interface ProductData {
  product: {
    id: string;
    categoryId: string;
    brandId: string | null;
    name: string;
    description: string | null;
    isVisible: boolean;
    fixedAttributes: Record<string, unknown>;
    variantOptionKeys: string[];
  };
  variants: Array<{
    id: string;
    optionValues: Record<string, unknown>;
    optionSignature: string;
    isDefault: boolean;
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

async function createAccount(
  options: {
    administrator?: boolean;
    elevated?: boolean;
  } = {},
): Promise<AdminFixture> {
  sequence += 1;
  const email = `catalog-admin-${runId}-${sequence}@example.test`;

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
    throw new Error('Could not create catalog test account.');
  }

  userIds.push(user.id);

  if (options.administrator) {
    await getDatabase().db.insert(identityUserPermissions).values({
      userId: user.id,
      permission: 'administrator',
    });
  }

  const session = await createSession(getDatabase().db, user.id);

  if (!session) {
    throw new Error('Could not create catalog test session.');
  }

  if (options.elevated) {
    await getDatabase()
      .db.update(identitySessions)
      .set({
        adminMfaElevatedAt: new Date(Date.now() - 5_000),
        adminMfaElevatedUntil: new Date(Date.now() + 10 * 60_000),
      })
      .where(eq(identitySessions.id, session.sessionId));
  }

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

async function createCategory(
  token: string,
  ruleSetKey = 'tennis_racquets',
  additions: Record<string, unknown> = {},
): Promise<CategoryData> {
  sequence += 1;

  const response = await request('POST', '/api/v1/admin/catalog/categories', token, {
    slug: `synthetic-category-${runId}-${sequence}`,
    name: `Synthetic category ${sequence}`,
    attributeRuleSetKey: ruleSetKey,
    ...additions,
  });

  expect(response.statusCode, response.body).toBe(201);
  const category = response.json<{ data: { category: CategoryData } }>().data.category;
  customCategoryIds.push(category.id);
  return category;
}

async function createBrand(
  token: string,
  additions: Record<string, unknown> = {},
): Promise<BrandData> {
  sequence += 1;

  const response = await request('POST', '/api/v1/admin/catalog/brands', token, {
    slug: `synthetic-brand-${runId}-${sequence}`,
    name: `Synthetic brand ${sequence}`,
    ...additions,
  });

  expect(response.statusCode, response.body).toBe(201);
  const brand = response.json<{ data: { brand: BrandData } }>().data.brand;
  customBrandIds.push(brand.id);
  return brand;
}

async function createProduct(
  token: string,
  categoryId: string,
  brandId: string | null,
  additions: Record<string, unknown> = {},
): Promise<ProductData> {
  const response = await request('POST', '/api/v1/admin/catalog/products', token, {
    categoryId,
    brandId,
    name: `Synthetic product ${runId}-${sequence}`,
    fixedAttributes: {
      audience: 'adult',
      lengthInches: 27,
      gripSize: 'L2',
    },
    ...additions,
  });

  expect(response.statusCode, response.body).toBe(201);
  const result = response.json<{ data: ProductData }>().data;
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

      if (customCategoryIds.length > 0) {
        await database.db
          .delete(catalogCategories)
          .where(inArray(catalogCategories.id, customCategoryIds));
      }

      if (customBrandIds.length > 0) {
        await database.db.delete(catalogBrands).where(inArray(catalogBrands.id, customBrandIds));
      }

      if (userIds.length > 0) {
        await database.db.delete(identityUsers).where(inArray(identityUsers.id, userIds));
      }
    }
  } finally {
    await Promise.allSettled([database?.close(), appDatabase?.close()]);
  }
});

describe('Admin catalog routes', () => {
  it('requires both administrator permission and current-session MFA elevation', async () => {
    const anonymous = await request('GET', '/api/v1/admin/catalog/categories');
    expect(anonymous.statusCode).toBe(401);

    const buyer = await createAccount();
    const buyerRequest = await request('GET', '/api/v1/admin/catalog/categories', buyer.token);
    expect(buyerRequest.statusCode).toBe(403);

    const unelevatedAdmin = await createAccount({ administrator: true });
    const unelevatedRequest = await request(
      'GET',
      '/api/v1/admin/catalog/categories',
      unelevatedAdmin.token,
    );
    expect(unelevatedRequest.statusCode).toBe(403);

    const admin = await createAccount({ administrator: true, elevated: true });
    const authorized = await request(
      'GET',
      '/api/v1/admin/catalog/categories?limit=10&offset=0',
      admin.token,
    );
    expect(authorized.statusCode, authorized.body).toBe(200);

    await getDatabase()
      .db.delete(identityUserPermissions)
      .where(eq(identityUserPermissions.userId, admin.id));

    const revoked = await request('GET', '/api/v1/admin/catalog/categories', admin.token);
    expect(revoked.statusCode).toBe(403);
  });

  it('manages categories and brands, including image URL set, replace, clear, and preserve', async () => {
    const admin = await createAccount({ administrator: true, elevated: true });

    const category = await createCategory(admin.token, 'tennis_bags', {
      imageUrl: 'https://images.example.test/category-one.png',
    });

    const categoryReplace = await request(
      'PATCH',
      `/api/v1/admin/catalog/categories/${category.id}`,
      admin.token,
      {
        name: 'Renamed synthetic category',
        imageUrl: 'https://images.example.test/category-two.png',
      },
    );
    expect(categoryReplace.statusCode, categoryReplace.body).toBe(200);
    const replacedCategory = categoryReplace.json<{ data: { category: CategoryData } }>().data
      .category;
    expect(replacedCategory.id).toBe(category.id);
    expect(replacedCategory.slug).toBe(category.slug);
    expect(replacedCategory.imageUrl).toBe('https://images.example.test/category-two.png');

    const categoryPreserve = await request(
      'PATCH',
      `/api/v1/admin/catalog/categories/${category.id}`,
      admin.token,
      { name: 'Renamed category, image preserved' },
    );
    expect(categoryPreserve.statusCode).toBe(200);
    expect(
      categoryPreserve.json<{ data: { category: CategoryData } }>().data.category.imageUrl,
    ).toBe('https://images.example.test/category-two.png');

    const invalidCategoryImage = await request(
      'PATCH',
      `/api/v1/admin/catalog/categories/${category.id}`,
      admin.token,
      { imageUrl: 'http://images.example.test/insecure.png' },
    );
    expect(invalidCategoryImage.statusCode).toBe(400);

    const categoryClear = await request(
      'PATCH',
      `/api/v1/admin/catalog/categories/${category.id}`,
      admin.token,
      { imageUrl: null },
    );
    expect(categoryClear.statusCode).toBe(200);
    expect(
      categoryClear.json<{ data: { category: CategoryData } }>().data.category.imageUrl,
    ).toBeNull();

    const duplicateCategory = await request(
      'POST',
      '/api/v1/admin/catalog/categories',
      admin.token,
      {
        slug: category.slug,
        name: 'Duplicate category slug',
        attributeRuleSetKey: 'tennis_racquets',
      },
    );
    expect(duplicateCategory.statusCode).toBe(409);

    const unsupportedRuleSet = await request(
      'POST',
      '/api/v1/admin/catalog/categories',
      admin.token,
      {
        slug: `unsupported-rule-${runId}`,
        name: 'Unsupported rule category',
        attributeRuleSetKey: 'not_a_supported_rule_set',
      },
    );
    expect(unsupportedRuleSet.statusCode).toBe(400);

    const brand = await createBrand(admin.token, {
      imageUrl: 'https://images.example.test/brand-one.png',
    });

    const brandReplace = await request(
      'PATCH',
      `/api/v1/admin/catalog/brands/${brand.id}`,
      admin.token,
      {
        name: 'Renamed synthetic brand',
        imageUrl: 'https://images.example.test/brand-two.png',
      },
    );
    expect(brandReplace.statusCode).toBe(200);
    const replacedBrand = brandReplace.json<{ data: { brand: BrandData } }>().data.brand;
    expect(replacedBrand.id).toBe(brand.id);
    expect(replacedBrand.slug).toBe(brand.slug);
    expect(replacedBrand.imageUrl).toBe('https://images.example.test/brand-two.png');

    const brandPreserve = await request(
      'PATCH',
      `/api/v1/admin/catalog/brands/${brand.id}`,
      admin.token,
      { name: 'Renamed brand, image preserved' },
    );
    expect(brandPreserve.statusCode).toBe(200);
    expect(brandPreserve.json<{ data: { brand: BrandData } }>().data.brand.imageUrl).toBe(
      'https://images.example.test/brand-two.png',
    );

    const invalidBrandImage = await request(
      'PATCH',
      `/api/v1/admin/catalog/brands/${brand.id}`,
      admin.token,
      { imageUrl: 'http://images.example.test/insecure.png' },
    );
    expect(invalidBrandImage.statusCode).toBe(400);

    const brandClear = await request(
      'PATCH',
      `/api/v1/admin/catalog/brands/${brand.id}`,
      admin.token,
      { imageUrl: null },
    );
    expect(brandClear.statusCode).toBe(200);
    expect(brandClear.json<{ data: { brand: BrandData } }>().data.brand.imageUrl).toBeNull();

    const duplicateBrand = await request('POST', '/api/v1/admin/catalog/brands', admin.token, {
      slug: brand.slug,
      name: 'Duplicate brand slug',
    });
    expect(duplicateBrand.statusCode).toBe(409);

    const deactivateCategory = await request(
      'PATCH',
      `/api/v1/admin/catalog/categories/${category.id}`,
      admin.token,
      { isActive: false },
    );
    expect(deactivateCategory.statusCode).toBe(200);

    const categoryList = await request(
      'GET',
      '/api/v1/admin/catalog/categories?limit=100&offset=0',
      admin.token,
    );
    expect(categoryList.statusCode).toBe(200);
    expect(
      categoryList
        .json<{ data: { items: CategoryData[] } }>()
        .data.items.some((item) => item.id === category.id && !item.isActive),
    ).toBe(true);
  });

  it('allows existing products to retain deactivated references but denies new assignments', async () => {
    const admin = await createAccount({ administrator: true, elevated: true });
    const category = await createCategory(admin.token);
    const brand = await createBrand(admin.token);

    const created = await createProduct(admin.token, category.id, brand.id, {
      name: `Product retaining inactive refs ${runId}`,
    });

    const categoryDeactivate = await request(
      'PATCH',
      `/api/v1/admin/catalog/categories/${category.id}`,
      admin.token,
      { isActive: false },
    );
    const brandDeactivate = await request(
      'PATCH',
      `/api/v1/admin/catalog/brands/${brand.id}`,
      admin.token,
      { isActive: false },
    );
    expect(categoryDeactivate.statusCode).toBe(200);
    expect(brandDeactivate.statusCode).toBe(200);

    const unrelatedEdit = await request(
      'PATCH',
      `/api/v1/admin/catalog/products/${created.product.id}`,
      admin.token,
      { name: `Unrelated edit ${runId}` },
    );
    expect(unrelatedEdit.statusCode, unrelatedEdit.body).toBe(200);
    const retained = unrelatedEdit.json<{ data: ProductData }>().data.product;
    expect(retained.categoryId).toBe(category.id);
    expect(retained.brandId).toBe(brand.id);

    const newCategoryAssignment = await request(
      'POST',
      '/api/v1/admin/catalog/products',
      admin.token,
      {
        categoryId: category.id,
        brandId: null,
        name: `Inactive category assignment ${runId}`,
        fixedAttributes: {
          audience: 'adult',
          lengthInches: 27,
          gripSize: 'L2',
        },
      },
    );
    expect(newCategoryAssignment.statusCode).toBe(400);

    const activeCategory = await createCategory(admin.token);
    const newBrandAssignment = await request(
      'POST',
      '/api/v1/admin/catalog/products',
      admin.token,
      {
        categoryId: activeCategory.id,
        brandId: brand.id,
        name: `Inactive brand assignment ${runId}`,
        fixedAttributes: {
          audience: 'adult',
          lengthInches: 27,
          gripSize: 'L2',
        },
      },
    );
    expect(newBrandAssignment.statusCode).toBe(400);
  });

  it('creates products, preserves unchanged variant IDs, and rolls back invalid updates', async () => {
    const admin = await createAccount({ administrator: true, elevated: true });
    const category = await createCategory(admin.token);
    const brand = await createBrand(admin.token);

    const created = await createProduct(admin.token, category.id, brand.id, {
      fixedAttributes: {
        audience: 'adult',
        lengthInches: 27,
      },
      variantOptionKeys: ['gripSize'],
      variants: [{ optionValues: { gripSize: 'L2' } }, { optionValues: { gripSize: 'L3' } }],
    });

    expect(created.product.isVisible).toBe(false);
    const originalIdsByGrip = new Map(
      created.variants.map((variant) => [variant.optionValues.gripSize, variant.id]),
    );
    expect([...originalIdsByGrip.keys()].sort()).toEqual(['L2', 'L3']);

    const update = await request(
      'PATCH',
      `/api/v1/admin/catalog/products/${created.product.id}`,
      admin.token,
      {
        isVisible: true,
        variants: [
          { optionValues: { gripSize: 'L2' } },
          { optionValues: { gripSize: 'L3' } },
          { optionValues: { gripSize: 'L4' } },
        ],
      },
    );
    expect(update.statusCode, update.body).toBe(200);
    const updated = update.json<{ data: ProductData }>().data;
    expect(updated.product.isVisible).toBe(true);
    expect(updated.variants).toHaveLength(3);

    const updatedIdsByGrip = new Map(
      updated.variants.map((variant) => [variant.optionValues.gripSize, variant.id]),
    );
    expect([...updatedIdsByGrip.keys()].sort()).toEqual(['L2', 'L3', 'L4']);
    expect(updatedIdsByGrip.get('L2')).toBe(originalIdsByGrip.get('L2'));
    expect(updatedIdsByGrip.get('L3')).toBe(originalIdsByGrip.get('L3'));
    expect(updatedIdsByGrip.has('L4')).toBe(true);

    const invalidUpdate = await request(
      'PATCH',
      `/api/v1/admin/catalog/products/${created.product.id}`,
      admin.token,
      {
        name: `Must not persist ${runId}`,
        variants: [{ optionValues: { gripSize: 'L2' } }, { optionValues: { gripSize: 'L2' } }],
      },
    );
    expect(invalidUpdate.statusCode).toBe(400);

    const afterInvalid = await request(
      'GET',
      `/api/v1/admin/catalog/products/${created.product.id}`,
      admin.token,
    );
    expect(afterInvalid.statusCode).toBe(200);
    expect(afterInvalid.json<{ data: ProductData }>().data.product.name).toBe(created.product.name);
    expect(afterInvalid.json<{ data: ProductData }>().data.variants).toHaveLength(3);

    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `tx_fail_catalog_variant_update_${suffix}`;
    const triggerName = `tx_fail_catalog_variant_update_${suffix}`;

    await getDatabase().pool.query(`
      CREATE FUNCTION ${functionName}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $body$
      BEGIN
        RAISE EXCEPTION 'synthetic catalog update variant failure';
      END;
      $body$
    `);

    try {
      await getDatabase().pool.query(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON catalog_variants
        FOR EACH ROW
        EXECUTE FUNCTION ${functionName}()
      `);

      const failedUpdate = await request(
        'PATCH',
        `/api/v1/admin/catalog/products/${created.product.id}`,
        admin.token,
        {
          name: `Must roll back ${runId}`,
          variants: [
            { optionValues: { gripSize: 'L2' } },
            { optionValues: { gripSize: 'L3' } },
            { optionValues: { gripSize: 'L4' } },
            { optionValues: { gripSize: 'L5' } },
          ],
        },
      );
      expect(failedUpdate.statusCode).toBe(500);

      const afterFailedWrite = await request(
        'GET',
        `/api/v1/admin/catalog/products/${created.product.id}`,
        admin.token,
      );
      expect(afterFailedWrite.statusCode).toBe(200);
      const persisted = afterFailedWrite.json<{ data: ProductData }>().data;
      expect(persisted.product.name).toBe(created.product.name);
      expect(persisted.variants.map((variant) => variant.id).sort()).toEqual(
        updated.variants.map((variant) => variant.id).sort(),
      );
    } finally {
      await getDatabase().pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON catalog_variants`);
      await getDatabase().pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
  });

  it('keeps Admin edits when launch data is loaded again', async () => {
    const admin = await createAccount({ administrator: true, elevated: true });
    await seedCatalogLaunchData(getDatabase().db);

    const [categoryBefore] = await getDatabase()
      .db.select()
      .from(catalogCategories)
      .where(eq(catalogCategories.slug, 'tennis-racquets'))
      .limit(1);
    const [brandBefore] = await getDatabase()
      .db.select()
      .from(catalogBrands)
      .where(eq(catalogBrands.slug, 'wilson'))
      .limit(1);

    if (!categoryBefore || !brandBefore) {
      throw new Error('Launch catalog rows were not loaded.');
    }

    try {
      const categoryEdit = await request(
        'PATCH',
        `/api/v1/admin/catalog/categories/${categoryBefore.id}`,
        admin.token,
        {
          name: `Admin-edited racquets ${runId}`,
          imageUrl: 'https://images.example.test/admin-racquets.png',
          isActive: false,
        },
      );
      const brandEdit = await request(
        'PATCH',
        `/api/v1/admin/catalog/brands/${brandBefore.id}`,
        admin.token,
        {
          name: `Admin-edited Wilson ${runId}`,
          imageUrl: 'https://images.example.test/admin-wilson.png',
          isActive: false,
        },
      );
      expect(categoryEdit.statusCode, categoryEdit.body).toBe(200);
      expect(brandEdit.statusCode, brandEdit.body).toBe(200);

      await seedCatalogLaunchData(getDatabase().db);
      await seedCatalogLaunchData(getDatabase().db);

      const [categoryAfter] = await getDatabase()
        .db.select()
        .from(catalogCategories)
        .where(eq(catalogCategories.id, categoryBefore.id))
        .limit(1);
      const [brandAfter] = await getDatabase()
        .db.select()
        .from(catalogBrands)
        .where(eq(catalogBrands.id, brandBefore.id))
        .limit(1);

      expect(categoryAfter).toMatchObject({
        id: categoryBefore.id,
        slug: categoryBefore.slug,
        name: `Admin-edited racquets ${runId}`,
        imageUrl: 'https://images.example.test/admin-racquets.png',
        isActive: false,
      });
      expect(brandAfter).toMatchObject({
        id: brandBefore.id,
        slug: brandBefore.slug,
        name: `Admin-edited Wilson ${runId}`,
        imageUrl: 'https://images.example.test/admin-wilson.png',
        isActive: false,
      });
    } finally {
      await getDatabase()
        .db.update(catalogCategories)
        .set({
          name: categoryBefore.name,
          imageUrl: categoryBefore.imageUrl,
          isActive: categoryBefore.isActive,
        })
        .where(eq(catalogCategories.id, categoryBefore.id));

      await getDatabase()
        .db.update(catalogBrands)
        .set({
          name: brandBefore.name,
          imageUrl: brandBefore.imageUrl,
          isActive: brandBefore.isActive,
        })
        .where(eq(catalogBrands.id, brandBefore.id));
    }
  });
});
