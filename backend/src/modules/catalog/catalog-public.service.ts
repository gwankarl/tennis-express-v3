import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import { catalogBrands } from './brand.table.js';
import { getPublicCatalogAttributeRules } from './catalog-public-rules.js';
import type { PublicCatalogAttributeRule } from './catalog-public-rules.js';
import type { CatalogAttributeRuleSetKey } from './category-attribute-rule-sets.js';
import { catalogCategories } from './category.table.js';
import { catalogProducts } from './product.table.js';
import { catalogVariants } from './variant.table.js';

type CatalogDatabase = DatabaseClient['db'];

export interface PublicCatalogCategory {
  id: string;
  slug: string;
  name: string;
  imageUrl: string | null;
  attributeRuleSetKey: CatalogAttributeRuleSetKey;
  attributeRules: PublicCatalogAttributeRule[];
}

export interface PublicCatalogBrand {
  id: string;
  slug: string;
  name: string;
  imageUrl: string | null;
}

export interface PublicCatalogProductQuery {
  limit: number;
  offset: number;
  categoryId?: string;
  brandId?: string;
}

export interface PublicCatalogProductWithVariants {
  product: {
    id: string;
    name: string;
    description: string | null;
    category: PublicCatalogCategory;
    brand: PublicCatalogBrand | null;
    fixedAttributes: Record<string, unknown>;
    variantOptionKeys: string[];
  };
  variants: {
    id: string;
    optionValues: Record<string, unknown>;
    isDefault: boolean;
  }[];
}

function toPublicCategory(category: typeof catalogCategories.$inferSelect): PublicCatalogCategory {
  return {
    id: category.id,
    slug: category.slug,
    name: category.name,
    imageUrl: category.imageUrl,
    attributeRuleSetKey: category.attributeRuleSetKey,
    attributeRules: getPublicCatalogAttributeRules(category.attributeRuleSetKey),
  };
}

function toPublicBrand(brand: typeof catalogBrands.$inferSelect): PublicCatalogBrand {
  return {
    id: brand.id,
    slug: brand.slug,
    name: brand.name,
    imageUrl: brand.imageUrl,
  };
}

async function loadPublicVariants(db: CatalogDatabase, productIds: string[]) {
  if (productIds.length === 0) {
    return [];
  }

  return db
    .select({
      id: catalogVariants.id,
      productId: catalogVariants.productId,
      optionValues: catalogVariants.optionValues,
      isDefault: catalogVariants.isDefault,
    })
    .from(catalogVariants)
    .where(inArray(catalogVariants.productId, productIds))
    .orderBy(asc(catalogVariants.productId), asc(catalogVariants.id));
}

function toPublicProducts(
  rows: Awaited<ReturnType<typeof loadVisibleProductRows>>,
  variants: Awaited<ReturnType<typeof loadPublicVariants>>,
): PublicCatalogProductWithVariants[] {
  const variantsByProductId = new Map<string, PublicCatalogProductWithVariants['variants']>();

  for (const variant of variants) {
    const existing = variantsByProductId.get(variant.productId) ?? [];
    existing.push({
      id: variant.id,
      optionValues: variant.optionValues,
      isDefault: variant.isDefault,
    });
    variantsByProductId.set(variant.productId, existing);
  }

  return rows.map(({ product, category, brand }) => ({
    product: {
      id: product.id,
      name: product.name,
      description: product.description,
      category: toPublicCategory(category),
      brand: brand ? toPublicBrand(brand) : null,
      fixedAttributes: product.fixedAttributes,
      variantOptionKeys: product.variantOptionKeys,
    },
    variants: variantsByProductId.get(product.id) ?? [],
  }));
}

function loadVisibleProductRows(db: CatalogDatabase) {
  return db
    .select({
      product: catalogProducts,
      category: catalogCategories,
      brand: catalogBrands,
    })
    .from(catalogProducts)
    .innerJoin(catalogCategories, eq(catalogProducts.categoryId, catalogCategories.id))
    .leftJoin(catalogBrands, eq(catalogProducts.brandId, catalogBrands.id));
}

export async function listPublicCatalogCategories(
  db: CatalogDatabase,
): Promise<{ items: PublicCatalogCategory[] }> {
  const rows = await db
    .select()
    .from(catalogCategories)
    .where(eq(catalogCategories.isActive, true))
    .orderBy(asc(catalogCategories.name), asc(catalogCategories.id));

  return { items: rows.map(toPublicCategory) };
}

export async function listPublicCatalogBrands(
  db: CatalogDatabase,
): Promise<{ items: PublicCatalogBrand[] }> {
  const rows = await db
    .select()
    .from(catalogBrands)
    .where(eq(catalogBrands.isActive, true))
    .orderBy(asc(catalogBrands.name), asc(catalogBrands.id));

  return { items: rows.map(toPublicBrand) };
}

export async function listPublicCatalogProducts(
  db: CatalogDatabase,
  query: PublicCatalogProductQuery,
): Promise<{
  items: PublicCatalogProductWithVariants[];
  limit: number;
  offset: number;
}> {
  const filters = [eq(catalogProducts.isVisible, true)];

  if (query.categoryId) {
    filters.push(eq(catalogProducts.categoryId, query.categoryId));
  }

  if (query.brandId) {
    filters.push(eq(catalogProducts.brandId, query.brandId));
  }

  const rows = await loadVisibleProductRows(db)
    .where(and(...filters))
    .orderBy(desc(catalogProducts.createdAt), desc(catalogProducts.id))
    .limit(query.limit)
    .offset(query.offset);

  const variants = await loadPublicVariants(
    db,
    rows.map(({ product }) => product.id),
  );

  return {
    items: toPublicProducts(rows, variants),
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getPublicCatalogProduct(
  db: CatalogDatabase,
  id: string,
): Promise<PublicCatalogProductWithVariants | null> {
  const [row] = await loadVisibleProductRows(db)
    .where(and(eq(catalogProducts.id, id), eq(catalogProducts.isVisible, true)))
    .limit(1);

  if (!row) {
    return null;
  }

  const variants = await loadPublicVariants(db, [row.product.id]);
  return toPublicProducts([row], variants)[0] ?? null;
}
