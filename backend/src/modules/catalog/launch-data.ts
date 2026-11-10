import type { DatabaseClient } from '../../infrastructure/database/client.js';
import { catalogBrands } from './brand.table.js';
import { catalogCategories } from './category.table.js';

export const launchCatalogCategories = [
  { slug: 'tennis-racquets', name: 'Tennis racquets', attributeRuleSetKey: 'tennis_racquets' },
  { slug: 'tennis-balls', name: 'Tennis balls', attributeRuleSetKey: 'tennis_balls' },
  { slug: 'racquet-strings', name: 'Racquet strings', attributeRuleSetKey: 'racquet_strings' },
  { slug: 'grips-overgrips', name: 'Grips and overgrips', attributeRuleSetKey: 'grips_overgrips' },
  { slug: 'tennis-shoes', name: 'Tennis shoes', attributeRuleSetKey: 'tennis_shoes' },
  { slug: 'tennis-bags', name: 'Tennis bags', attributeRuleSetKey: 'tennis_bags' },
  {
    slug: 'racquet-accessories',
    name: 'Racquet accessories',
    attributeRuleSetKey: 'racquet_accessories',
  },
] as const;

export const launchCatalogBrands = [
  { slug: 'wilson', name: 'Wilson' },
  { slug: 'head', name: 'HEAD' },
  { slug: 'babolat', name: 'Babolat' },
  { slug: 'yonex', name: 'Yonex' },
  { slug: 'dunlop', name: 'Dunlop' },
  { slug: 'tecnifibre', name: 'Tecnifibre' },
  { slug: 'prince', name: 'Prince' },
  { slug: 'artengo', name: 'Artengo' },
  { slug: 'asics', name: 'ASICS' },
  { slug: 'adidas', name: 'adidas' },
  { slug: 'nike', name: 'Nike' },
] as const;

/**
 * Inserts missing launch reference data without changing existing rows.
 * Slugs are the conflict keys; existing IDs, names, and active states survive reruns.
 */
export async function seedCatalogLaunchData(db: DatabaseClient['db']): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(catalogCategories)
      .values([...launchCatalogCategories])
      .onConflictDoNothing({ target: catalogCategories.slug });

    await tx
      .insert(catalogBrands)
      .values([...launchCatalogBrands])
      .onConflictDoNothing({ target: catalogBrands.slug });
  });
}
