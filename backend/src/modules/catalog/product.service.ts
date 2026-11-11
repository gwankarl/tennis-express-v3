import { asc, eq, inArray } from 'drizzle-orm';
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

export interface CatalogProductPagination {
  limit: number;
  offset: number;
}

export interface CreateCatalogProductInput {
  categoryId: string;
  brandId: string | null;
  name: string;
  description?: string | null;
  isVisible?: boolean;
  fixedAttributes?: Record<string, unknown>;
  variantOptionKeys?: readonly string[];
  variants?: readonly CatalogVariantInput[];
}

export interface UpdateCatalogProductInput {
  categoryId?: string;
  brandId?: string | null;
  name?: string;
  description?: string | null;
  isVisible?: boolean;
  fixedAttributes?: Record<string, unknown>;
  variantOptionKeys?: readonly string[];
  variants?: readonly CatalogVariantInput[];
}

export interface CatalogProductWithVariants {
  product: typeof catalogProducts.$inferSelect;
  variants: (typeof catalogVariants.$inferSelect)[];
}

export class CatalogProductServiceError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    readonly field: 'id' | 'categoryId' | 'brandId' | 'name' | 'attributes' | 'variants',
    readonly rule: 'required' | 'not_found' | 'inactive' | 'configuration_required' | 'duplicate',
  ) {
    super('Catalog product request failed.');
    this.name = 'CatalogProductServiceError';
  }
}

function normalizeName(name: string): string {
  const normalized = name.trim();

  if (!normalized) {
    throw new CatalogProductServiceError(400, 'name', 'required');
  }

  return normalized;
}

function normalizeDescription(description: string | null | undefined): string | null {
  return description?.trim() || null;
}

function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };

    if (candidate.code === '23505') {
      return true;
    }

    current = candidate.cause;
  }

  return false;
}

async function loadVariants(
  db: CatalogDatabase,
  productIds: string[],
): Promise<(typeof catalogVariants.$inferSelect)[]> {
  if (productIds.length === 0) {
    return [];
  }

  return db
    .select()
    .from(catalogVariants)
    .where(inArray(catalogVariants.productId, productIds))
    .orderBy(asc(catalogVariants.productId), asc(catalogVariants.optionSignature));
}

function groupProductsWithVariants(
  products: (typeof catalogProducts.$inferSelect)[],
  variants: (typeof catalogVariants.$inferSelect)[],
): CatalogProductWithVariants[] {
  return products.map((product) => ({
    product,
    variants: variants.filter((variant) => variant.productId === product.id),
  }));
}

export async function listAdminCatalogProducts(
  db: CatalogDatabase,
  pagination: CatalogProductPagination,
): Promise<{
  items: CatalogProductWithVariants[];
  limit: number;
  offset: number;
}> {
  const products = await db
    .select()
    .from(catalogProducts)
    .orderBy(asc(catalogProducts.name), asc(catalogProducts.id))
    .limit(pagination.limit)
    .offset(pagination.offset);

  const variants = await loadVariants(
    db,
    products.map((product) => product.id),
  );

  return {
    items: groupProductsWithVariants(products, variants),
    ...pagination,
  };
}

export async function getAdminCatalogProduct(
  db: CatalogDatabase,
  id: string,
): Promise<CatalogProductWithVariants> {
  const [product] = await db
    .select()
    .from(catalogProducts)
    .where(eq(catalogProducts.id, id))
    .limit(1);

  if (!product) {
    throw new CatalogProductServiceError(404, 'id', 'not_found');
  }

  const variants = await loadVariants(db, [product.id]);
  return { product, variants };
}

/**
 * Creates the product and all initial variants in one transaction.
 * Category and brand rows are locked while their active state is checked.
 */
export async function createCatalogProduct(
  db: CatalogDatabase,
  input: CreateCatalogProductInput,
): Promise<CatalogProductWithVariants> {
  const name = normalizeName(input.name);
  const description = normalizeDescription(input.description);

  try {
    return await db.transaction(async (tx) => {
      const [category] = await tx
        .select()
        .from(catalogCategories)
        .where(eq(catalogCategories.id, input.categoryId))
        .for('update')
        .limit(1);

      if (!category) {
        throw new CatalogProductServiceError(400, 'categoryId', 'not_found');
      }

      if (!category.isActive) {
        throw new CatalogProductServiceError(400, 'categoryId', 'inactive');
      }

      if (input.brandId !== null) {
        const [brand] = await tx
          .select()
          .from(catalogBrands)
          .where(eq(catalogBrands.id, input.brandId))
          .for('update')
          .limit(1);

        if (!brand) {
          throw new CatalogProductServiceError(400, 'brandId', 'not_found');
        }

        if (!brand.isActive) {
          throw new CatalogProductServiceError(400, 'brandId', 'inactive');
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
          isVisible: input.isVisible ?? false,
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
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CatalogProductServiceError(409, 'variants', 'duplicate');
    }

    throw error;
  }
}

/**
 * Updates product metadata and, when supplied, revalidates the full effective
 * attribute configuration. Variants with unchanged signatures keep their IDs.
 */
export async function updateCatalogProduct(
  db: CatalogDatabase,
  id: string,
  input: UpdateCatalogProductInput,
): Promise<CatalogProductWithVariants> {
  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(catalogProducts)
        .where(eq(catalogProducts.id, id))
        .for('update')
        .limit(1);

      if (!current) {
        throw new CatalogProductServiceError(404, 'id', 'not_found');
      }

      const currentVariants = await tx
        .select()
        .from(catalogVariants)
        .where(eq(catalogVariants.productId, current.id))
        .for('update');

      const categoryId = input.categoryId ?? current.categoryId;
      const brandId = input.brandId === undefined ? current.brandId : input.brandId;
      const categoryChanged = categoryId !== current.categoryId;

      const [category] = await tx
        .select()
        .from(catalogCategories)
        .where(eq(catalogCategories.id, categoryId))
        .for('update')
        .limit(1);

      if (!category) {
        throw new CatalogProductServiceError(400, 'categoryId', 'not_found');
      }

      if (categoryChanged && !category.isActive) {
        throw new CatalogProductServiceError(400, 'categoryId', 'inactive');
      }

      if (
        categoryChanged &&
        (input.fixedAttributes === undefined || input.variantOptionKeys === undefined)
      ) {
        throw new CatalogProductServiceError(400, 'attributes', 'configuration_required');
      }

      if (brandId !== null) {
        const [brand] = await tx
          .select()
          .from(catalogBrands)
          .where(eq(catalogBrands.id, brandId))
          .for('update')
          .limit(1);

        if (!brand) {
          throw new CatalogProductServiceError(400, 'brandId', 'not_found');
        }

        if (brandId !== current.brandId && !brand.isActive) {
          throw new CatalogProductServiceError(400, 'brandId', 'inactive');
        }
      }

      const configurationChanged =
        categoryChanged ||
        input.fixedAttributes !== undefined ||
        input.variantOptionKeys !== undefined ||
        input.variants !== undefined;

      const validated = configurationChanged
        ? validateCatalogProductAttributes({
            ruleSetKey: category.attributeRuleSetKey,
            fixedAttributes: input.fixedAttributes ?? current.fixedAttributes,
            variantOptionKeys: input.variantOptionKeys ?? current.variantOptionKeys,
            variants:
              input.variants ??
              (input.variantOptionKeys?.length === 0
                ? []
                : currentVariants.map((variant) => ({
                    optionValues: variant.optionValues,
                  }))),
          })
        : undefined;

      const updateValues: {
        categoryId: string;
        brandId: string | null;
        name: string;
        description: string | null;
        isVisible: boolean;
        fixedAttributes?: Record<string, unknown>;
        variantOptionKeys?: string[];
        updatedAt: Date;
      } = {
        categoryId,
        brandId,
        name: input.name === undefined ? current.name : normalizeName(input.name),
        description:
          input.description === undefined
            ? current.description
            : normalizeDescription(input.description),
        isVisible: input.isVisible ?? current.isVisible,
        updatedAt: new Date(),
      };

      if (validated) {
        updateValues.fixedAttributes = validated.fixedAttributes;
        updateValues.variantOptionKeys = validated.variantOptionKeys;
      }

      const [product] = await tx
        .update(catalogProducts)
        .set(updateValues)
        .where(eq(catalogProducts.id, current.id))
        .returning();

      if (!validated) {
        return { product, variants: currentVariants };
      }

      const existingBySignature = new Map(
        currentVariants.map((variant) => [variant.optionSignature, variant]),
      );
      const retainedSignatures = new Set<string>();
      const variants: (typeof catalogVariants.$inferSelect)[] = [];

      for (const validatedVariant of validated.variants) {
        const existing = existingBySignature.get(validatedVariant.optionSignature);

        if (existing) {
          const [updatedVariant] = await tx
            .update(catalogVariants)
            .set({
              optionValues: validatedVariant.optionValues,
              isDefault: validatedVariant.isDefault,
              updatedAt: new Date(),
            })
            .where(eq(catalogVariants.id, existing.id))
            .returning();

          if (!updatedVariant) {
            throw new CatalogProductServiceError(409, 'variants', 'duplicate');
          }

          retainedSignatures.add(existing.optionSignature);
          variants.push(updatedVariant);
          continue;
        }

        const [createdVariant] = await tx
          .insert(catalogVariants)
          .values({
            productId: product.id,
            optionValues: validatedVariant.optionValues,
            optionSignature: validatedVariant.optionSignature,
            isDefault: validatedVariant.isDefault,
          })
          .returning();

        variants.push(createdVariant);
      }

      for (const existing of currentVariants) {
        if (!retainedSignatures.has(existing.optionSignature)) {
          await tx.delete(catalogVariants).where(eq(catalogVariants.id, existing.id));
        }
      }

      return { product, variants };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CatalogProductServiceError(409, 'variants', 'duplicate');
    }

    throw error;
  }
}
