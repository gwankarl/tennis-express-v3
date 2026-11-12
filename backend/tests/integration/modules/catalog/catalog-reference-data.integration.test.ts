import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, count, eq, inArray } from 'drizzle-orm';
import {
  createDatabaseClient,
  type DatabaseClient,
} from '../../../../src/infrastructure/database/client.js';
import { catalogBrands } from '../../../../src/modules/catalog/brand.table.js';
import { catalogCategories } from '../../../../src/modules/catalog/category.table.js';
import { seedCatalogLaunchData } from '../../../../src/modules/catalog/launch-data.js';
import {
  requireTestDatabaseUrl,
  verifyTestDatabaseIdentity,
} from '../../../helpers/test-database.js';

let database: DatabaseClient | undefined;

const launchCategorySlugs = [
  'grips-overgrips',
  'racquet-accessories',
  'racquet-strings',
  'tennis-bags',
  'tennis-balls',
  'tennis-racquets',
  'tennis-shoes',
] as const;

const launchBrandSlugs = [
  'adidas',
  'artengo',
  'asics',
  'babolat',
  'dunlop',
  'head',
  'nike',
  'prince',
  'tecnifibre',
  'wilson',
  'yonex',
] as const;

function getDatabase(): DatabaseClient {
  if (!database) {
    throw new Error('Test database was not initialized.');
  }

  return database;
}

beforeAll(async () => {
  database = createDatabaseClient(requireTestDatabaseUrl());
  await verifyTestDatabaseIdentity(database.pool);
});

afterAll(async () => {
  await database?.close();
});

describe('catalog reference data', () => {
  it('loads exactly the launch categories and brands', async () => {
    const db = getDatabase();

    await seedCatalogLaunchData(db.db);

    const categories = await db.db
      .select({
        slug: catalogCategories.slug,
        name: catalogCategories.name,
        attributeRuleSetKey: catalogCategories.attributeRuleSetKey,
        isActive: catalogCategories.isActive,
      })
      .from(catalogCategories)
      .where(inArray(catalogCategories.slug, launchCategorySlugs))
      .orderBy(asc(catalogCategories.slug));

    const brands = await db.db
      .select({
        slug: catalogBrands.slug,
        name: catalogBrands.name,
        isActive: catalogBrands.isActive,
      })
      .from(catalogBrands)
      .where(inArray(catalogBrands.slug, launchBrandSlugs))
      .orderBy(asc(catalogBrands.slug));

    expect(categories).toEqual([
      {
        slug: 'grips-overgrips',
        name: 'Grips and overgrips',
        attributeRuleSetKey: 'grips_overgrips',
        isActive: true,
      },
      {
        slug: 'racquet-accessories',
        name: 'Racquet accessories',
        attributeRuleSetKey: 'racquet_accessories',
        isActive: true,
      },
      {
        slug: 'racquet-strings',
        name: 'Racquet strings',
        attributeRuleSetKey: 'racquet_strings',
        isActive: true,
      },
      {
        slug: 'tennis-bags',
        name: 'Tennis bags',
        attributeRuleSetKey: 'tennis_bags',
        isActive: true,
      },
      {
        slug: 'tennis-balls',
        name: 'Tennis balls',
        attributeRuleSetKey: 'tennis_balls',
        isActive: true,
      },
      {
        slug: 'tennis-racquets',
        name: 'Tennis racquets',
        attributeRuleSetKey: 'tennis_racquets',
        isActive: true,
      },
      {
        slug: 'tennis-shoes',
        name: 'Tennis shoes',
        attributeRuleSetKey: 'tennis_shoes',
        isActive: true,
      },
    ]);

    expect(brands).toEqual([
      { slug: 'adidas', name: 'adidas', isActive: true },
      { slug: 'artengo', name: 'Artengo', isActive: true },
      { slug: 'asics', name: 'ASICS', isActive: true },
      { slug: 'babolat', name: 'Babolat', isActive: true },
      { slug: 'dunlop', name: 'Dunlop', isActive: true },
      { slug: 'head', name: 'HEAD', isActive: true },
      { slug: 'nike', name: 'Nike', isActive: true },
      { slug: 'prince', name: 'Prince', isActive: true },
      { slug: 'tecnifibre', name: 'Tecnifibre', isActive: true },
      { slug: 'wilson', name: 'Wilson', isActive: true },
      { slug: 'yonex', name: 'Yonex', isActive: true },
    ]);

    const [categoryCount] = await db.db
      .select({ value: count() })
      .from(catalogCategories)
      .where(inArray(catalogCategories.slug, launchCategorySlugs));
    const [brandCount] = await db.db
      .select({ value: count() })
      .from(catalogBrands)
      .where(inArray(catalogBrands.slug, launchBrandSlugs));

    expect(categoryCount?.value).toBe(7);
    expect(brandCount?.value).toBe(11);
  });

  it('preserves IDs, renamed labels, and inactive state when the loader is rerun', async () => {
    const db = getDatabase();

    await seedCatalogLaunchData(db.db);

    const [categoryBefore] = await db.db
      .select({
        id: catalogCategories.id,
        slug: catalogCategories.slug,
        name: catalogCategories.name,
        isActive: catalogCategories.isActive,
      })
      .from(catalogCategories)
      .where(eq(catalogCategories.slug, 'tennis-racquets'))
      .limit(1);

    const [brandBefore] = await db.db
      .select({
        id: catalogBrands.id,
        slug: catalogBrands.slug,
        name: catalogBrands.name,
        isActive: catalogBrands.isActive,
      })
      .from(catalogBrands)
      .where(eq(catalogBrands.slug, 'wilson'))
      .limit(1);

    if (!categoryBefore || !brandBefore) {
      throw new Error('Expected launch reference records were not loaded.');
    }

    try {
      await db.db
        .update(catalogCategories)
        .set({ name: 'Synthetic renamed racquets', isActive: false })
        .where(eq(catalogCategories.id, categoryBefore.id));

      await db.db
        .update(catalogBrands)
        .set({ name: 'Synthetic renamed brand', isActive: false })
        .where(eq(catalogBrands.id, brandBefore.id));

      await seedCatalogLaunchData(db.db);
      await seedCatalogLaunchData(db.db);

      const [categoryAfter] = await db.db
        .select({
          id: catalogCategories.id,
          slug: catalogCategories.slug,
          name: catalogCategories.name,
          isActive: catalogCategories.isActive,
        })
        .from(catalogCategories)
        .where(eq(catalogCategories.slug, 'tennis-racquets'))
        .limit(1);

      const [brandAfter] = await db.db
        .select({
          id: catalogBrands.id,
          slug: catalogBrands.slug,
          name: catalogBrands.name,
          isActive: catalogBrands.isActive,
        })
        .from(catalogBrands)
        .where(eq(catalogBrands.slug, 'wilson'))
        .limit(1);

      expect(categoryAfter).toEqual({
        id: categoryBefore.id,
        slug: categoryBefore.slug,
        name: 'Synthetic renamed racquets',
        isActive: false,
      });

      expect(brandAfter).toEqual({
        id: brandBefore.id,
        slug: brandBefore.slug,
        name: 'Synthetic renamed brand',
        isActive: false,
      });

      const [categoryCount] = await db.db
        .select({ value: count() })
        .from(catalogCategories)
        .where(inArray(catalogCategories.slug, launchCategorySlugs));
      const [brandCount] = await db.db
        .select({ value: count() })
        .from(catalogBrands)
        .where(inArray(catalogBrands.slug, launchBrandSlugs));

      expect(categoryCount?.value).toBe(7);
      expect(brandCount?.value).toBe(11);
    } finally {
      await db.db
        .update(catalogCategories)
        .set({ name: categoryBefore.name, isActive: categoryBefore.isActive })
        .where(eq(catalogCategories.id, categoryBefore.id));

      await db.db
        .update(catalogBrands)
        .set({ name: brandBefore.name, isActive: brandBefore.isActive })
        .where(eq(catalogBrands.id, brandBefore.id));
    }
  });

  it('enforces unique slugs for categories and brands', async () => {
    const db = getDatabase();
    const categorySlug = `duplicate-category-${randomUUID()}`;
    const brandSlug = `duplicate-brand-${randomUUID()}`;

    await expect(
      db.pool.query(
        `INSERT INTO catalog_categories (slug, name, attribute_rule_set_key)
         VALUES ($1, 'Synthetic category one', 'tennis_racquets'),
                ($1, 'Synthetic category two', 'tennis_racquets')`,
        [categorySlug],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    await expect(
      db.pool.query(
        `INSERT INTO catalog_brands (slug, name)
         VALUES ($1, 'Synthetic brand one'),
                ($1, 'Synthetic brand two')`,
        [brandSlug],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
