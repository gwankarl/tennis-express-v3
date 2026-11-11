import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../src/infrastructure/database/client.js';
import { catalogBrands } from '../../../../src/modules/catalog/brand.table.js';
import { catalogCategories } from '../../../../src/modules/catalog/category.table.js';
import { catalogProducts } from '../../../../src/modules/catalog/product.table.js';
import { createCatalogProduct } from '../../../../src/modules/catalog/product.service.js';
import { catalogVariants } from '../../../../src/modules/catalog/variant.table.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../helpers/test-database.js';

const runId = randomUUID();
const categoryIds: string[] = [];
const brandIds: string[] = [];
let sequence = 0;
let database: DatabaseClient | undefined;

function getDatabase(): DatabaseClient {
  if (!database) {
    throw new Error('Test database was not initialized.');
  }

  return database;
}

async function createReferences(ruleSetKey = 'tennis_racquets') {
  sequence += 1;

  const [category] = await getDatabase()
    .db.insert(catalogCategories)
    .values({
      slug: `synthetic-${runId}-${sequence}`,
      name: `Synthetic category ${sequence}`,
      attributeRuleSetKey: ruleSetKey as
        | 'tennis_racquets'
        | 'tennis_balls'
        | 'racquet_strings'
        | 'grips_overgrips'
        | 'tennis_shoes'
        | 'tennis_bags'
        | 'racquet_accessories',
    })
    .returning({ id: catalogCategories.id });

  const [brand] = await getDatabase()
    .db.insert(catalogBrands)
    .values({
      slug: `synthetic-${runId}-${sequence}`,
      name: `Synthetic brand ${sequence}`,
    })
    .returning({ id: catalogBrands.id });

  if (!category || !brand) {
    throw new Error('Could not create synthetic catalog references.');
  }

  categoryIds.push(category.id);
  brandIds.push(brand.id);

  return { categoryId: category.id, brandId: brand.id };
}

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl());
  await verifyTestDatabaseIdentity(database.pool);
});

afterAll(async () => {
  const db = database;

  if (!db) {
    return;
  }

  try {
    if (categoryIds.length > 0) {
      await db.db.delete(catalogProducts).where(inArray(catalogProducts.categoryId, categoryIds));

      await db.db.delete(catalogCategories).where(inArray(catalogCategories.id, categoryIds));
    }

    if (brandIds.length > 0) {
      await db.db.delete(catalogBrands).where(inArray(catalogBrands.id, brandIds));
    }
  } finally {
    await db.close();
  }
});

describe('catalog product persistence', () => {
  it('persists a fixed-size product with exactly one default variant', async () => {
    const db = getDatabase();
    const references = await createReferences();
    const name = `Synthetic fixed product ${runId}`;

    const result = await createCatalogProduct(db.db, {
      ...references,
      name,
      fixedAttributes: {
        audience: 'adult',
        lengthInches: 27,
        gripSize: 'L2',
      },
    });

    expect(result.product.name).toBe(name);
    expect(result.product.fixedAttributes).toEqual({
      audience: 'adult',
      lengthInches: 27,
      gripSize: 'L2',
    });
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]).toMatchObject({
      productId: result.product.id,
      optionValues: {},
      optionSignature: '{}',
      isDefault: true,
    });

    const storedVariants = await db.db
      .select()
      .from(catalogVariants)
      .where(eq(catalogVariants.productId, result.product.id));

    expect(storedVariants).toHaveLength(1);
  });

  it('persists multiple valid configurations for selected options', async () => {
    const db = getDatabase();
    const references = await createReferences('tennis_balls');

    const result = await createCatalogProduct(db.db, {
      ...references,
      name: `Synthetic ball product ${runId}`,
      fixedAttributes: {
        typeOrStage: 'standard',
        pressurization: 'pressurized',
      },
      variantOptionKeys: ['ballsPerPack'],
      variants: [{ optionValues: { ballsPerPack: 3 } }, { optionValues: { ballsPerPack: 4 } }],
    });

    expect(result.variants).toHaveLength(2);
    expect(result.variants.map((variant) => variant.optionSignature).sort()).toEqual([
      '{"ballsPerPack":3}',
      '{"ballsPerPack":4}',
    ]);
    expect(result.variants.every((variant) => !variant.isDefault)).toBe(true);
  });

  it('persists explicit Unbranded selection as a null brand reference', async () => {
    const db = getDatabase();
    const { categoryId } = await createReferences();

    const result = await createCatalogProduct(db.db, {
      categoryId,
      brandId: null,
      name: `Synthetic unbranded product ${runId}`,
      fixedAttributes: {
        audience: 'junior',
        lengthInches: 25,
      },
    });

    expect(result.product.brandId).toBeNull();
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.isDefault).toBe(true);
  });

  it('rejects inactive categories and brands for new products', async () => {
    const db = getDatabase();
    const references = await createReferences();

    await db.db
      .update(catalogCategories)
      .set({ isActive: false })
      .where(eq(catalogCategories.id, references.categoryId));

    await expect(
      createCatalogProduct(db.db, {
        ...references,
        name: `Inactive category product ${runId}`,
        fixedAttributes: {
          audience: 'adult',
          lengthInches: 27,
          gripSize: 'L2',
        },
      }),
    ).rejects.toMatchObject({
      name: 'CatalogProductServiceError',
      field: 'categoryId',
      rule: 'inactive',
    });

    await db.db
      .update(catalogCategories)
      .set({ isActive: true })
      .where(eq(catalogCategories.id, references.categoryId));

    await db.db
      .update(catalogBrands)
      .set({ isActive: false })
      .where(eq(catalogBrands.id, references.brandId));

    await expect(
      createCatalogProduct(db.db, {
        ...references,
        name: `Inactive brand product ${runId}`,
        fixedAttributes: {
          audience: 'adult',
          lengthInches: 27,
          gripSize: 'L2',
        },
      }),
    ).rejects.toMatchObject({
      name: 'CatalogProductServiceError',
      field: 'brandId',
      rule: 'inactive',
    });
  });

  it('rejects duplicate combinations even when option keys arrive in a different order', async () => {
    const db = getDatabase();
    const references = await createReferences('grips_overgrips');

    await expect(
      createCatalogProduct(db.db, {
        ...references,
        name: `Synthetic duplicate product ${runId}`,
        fixedAttributes: { gripType: 'overgrip' },
        variantOptionKeys: ['color', 'piecesPerPack'],
        variants: [
          { optionValues: { color: 'black', piecesPerPack: 3 } },
          { optionValues: { piecesPerPack: 3, color: 'black' } },
        ],
      }),
    ).rejects.toMatchObject({
      name: 'CatalogProductValidationError',
      field: 'variants',
      rule: 'duplicate_variant_combination',
    });

    const insertedProducts = await db.db
      .select({ id: catalogProducts.id })
      .from(catalogProducts)
      .where(eq(catalogProducts.name, `Synthetic duplicate product ${runId}`));

    expect(insertedProducts).toHaveLength(0);
  });

  it('rolls back the product insert if a variant insert fails', async () => {
    const db = getDatabase();
    const references = await createReferences();
    const name = `Synthetic rollback product ${runId}`;
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `tx_fail_catalog_variant_${suffix}`;
    const triggerName = `tx_fail_catalog_variant_${suffix}`;

    await db.pool.query(`
      CREATE FUNCTION ${functionName}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $body$
      BEGIN
        RAISE EXCEPTION 'synthetic catalog variant insert failure';
      END;
      $body$
    `);

    try {
      await db.pool.query(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON catalog_variants
        FOR EACH ROW
        EXECUTE FUNCTION ${functionName}()
      `);

      await expect(
        createCatalogProduct(db.db, {
          ...references,
          name,
          fixedAttributes: {
            audience: 'adult',
            lengthInches: 27,
            gripSize: 'L2',
          },
        }),
      ).rejects.toThrow();

      const insertedProducts = await db.db
        .select({ id: catalogProducts.id })
        .from(catalogProducts)
        .where(eq(catalogProducts.name, name));

      expect(insertedProducts).toHaveLength(0);
    } finally {
      await db.pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON catalog_variants`);
      await db.pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
  });
});
