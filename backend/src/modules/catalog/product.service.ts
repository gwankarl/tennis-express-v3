import { eq } from 'drizzle-orm';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import { catalogBrands } from './brand.table.js';
import { catalogCategories } from './category.table.js';
import {
  validateCatalogProductAttributes,
  type CatalogVariantInput,
} from './product-validation.js';
import { catalogProducts } from './product.table.js';
import { catalogVariants } from './variant.table.js';

type CatalogDatabase = DatabaseClient['db'];

export interface CreateCatalogProductInput {
  categoryId: string;
  brandId: string | null;
  name: string;
  description?: string | null;
  fixedAttributes?: Record<string, unknown>;
  variantOptionKeys?: readonly string[];
  variants?: readonly CatalogVariantInput[];
}

export interface CreatedCatalogProduct {
  product: typeof catalogProducts.$inferSelect;
  variants: (typeof catalogVariants.$inferSelect)[];
}

export class CatalogProductServiceError extends Error {
  constructor(
    readonly field: 'categoryId' | 'brandId' | 'name',
    readonly rule: 'required' | 'not_found' | 'inactive',
  ) {
    super('Catalog product could not be created.');
    this.name = 'CatalogProductServiceError';
  }
}

/**
 * Creates a catalog product and its complete initial variant set atomically.
 *
 * Category and brand rows are locked while checked so they cannot be
 * deactivated between eligibility checks and product creation.
 */
export async function createCatalogProduct(
  db: CatalogDatabase,
  input: CreateCatalogProductInput,
): Promise<CreatedCatalogProduct> {
  const name = input.name.trim();

  if (!name) {
    throw new CatalogProductServiceError('name', 'required');
  }

  const description = input.description?.trim() || null;

  return db.transaction(async (tx) => {
    const [category] = await tx
      .select({
        id: catalogCategories.id,
        isActive: catalogCategories.isActive,
        attributeRuleSetKey: catalogCategories.attributeRuleSetKey,
      })
      .from(catalogCategories)
      .where(eq(catalogCategories.id, input.categoryId))
      .for('update')
      .limit(1);

    if (!category) {
      throw new CatalogProductServiceError('categoryId', 'not_found');
    }

    if (!category.isActive) {
      throw new CatalogProductServiceError('categoryId', 'inactive');
    }

    if (input.brandId !== null) {
      const [brand] = await tx
        .select({
          id: catalogBrands.id,
          isActive: catalogBrands.isActive,
        })
        .from(catalogBrands)
        .where(eq(catalogBrands.id, input.brandId))
        .for('update')
        .limit(1);

      if (!brand) {
        throw new CatalogProductServiceError('brandId', 'not_found');
      }

      if (!brand.isActive) {
        throw new CatalogProductServiceError('brandId', 'inactive');
      }
    }

    const validated = validateCatalogProductAttributes({
      ruleSetKey: category.attributeRuleSetKey,
      fixedAttributes: input.fixedAttributes,
      variantOptionKeys: input.variantOptionKeys,
      variants: input.variants,
    });

    const [product] = await tx
      .insert(catalogProducts)
      .values({
        categoryId: category.id,
        brandId: input.brandId,
        name,
        description,
        fixedAttributes: validated.fixedAttributes,
        variantOptionKeys: validated.variantOptionKeys,
      })
      .returning();

    const variants = await tx
      .insert(catalogVariants)
      .values(
        validated.variants.map((variant) => ({
          productId: product.id,
          optionValues: variant.optionValues,
          optionSignature: variant.optionSignature,
          isDefault: variant.isDefault,
        })),
      )
      .returning();

    return { product, variants };
  });
}
