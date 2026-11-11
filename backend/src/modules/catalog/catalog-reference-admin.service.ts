import { asc, eq } from 'drizzle-orm';
import type { DatabaseClient } from '../../infrastructure/database/client.js';
import { catalogBrands } from './brand.table.js';
import {
  catalogAttributeRuleSetKeys,
  type CatalogAttributeRuleSetKey,
} from './category-attribute-rule-sets.js';
import { catalogCategories } from './category.table.js';

type CatalogDatabase = DatabaseClient['db'];

export interface CatalogReferencePagination {
  limit: number;
  offset: number;
}

export interface CreateCatalogCategoryInput {
  slug: string;
  name: string;
  imageUrl?: string | null;
  attributeRuleSetKey: CatalogAttributeRuleSetKey;
  isActive?: boolean;
}

export interface UpdateCatalogCategoryInput {
  name?: string;
  imageUrl?: string | null;
  isActive?: boolean;
}

export interface CreateCatalogBrandInput {
  slug: string;
  name: string;
  imageUrl?: string | null;
  isActive?: boolean;
}

export interface UpdateCatalogBrandInput {
  name?: string;
  imageUrl?: string | null;
  isActive?: boolean;
}

export class CatalogReferenceAdminServiceError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    readonly field: 'id' | 'slug' | 'name' | 'imageUrl' | 'attributeRuleSetKey',
    readonly rule:
      'not_found' | 'duplicate' | 'required' | 'invalid_slug' | 'https_required' | 'unsupported',
  ) {
    super('Catalog reference request failed.');
    this.name = 'CatalogReferenceAdminServiceError';
  }
}

function normalizeName(name: string): string {
  const normalized = name.trim();

  if (!normalized) {
    throw new CatalogReferenceAdminServiceError(400, 'name', 'required');
  }

  return normalized;
}

function validateSlug(slug: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
    throw new CatalogReferenceAdminServiceError(400, 'slug', 'invalid_slug');
  }

  return slug;
}

function validateImageUrl(imageUrl: string | null | undefined): string | null | undefined {
  if (imageUrl === undefined || imageUrl === null) {
    return imageUrl;
  }

  try {
    const parsed = new URL(imageUrl);

    if (parsed.protocol !== 'https:' || !parsed.hostname) {
      throw new Error('HTTPS required.');
    }
  } catch {
    throw new CatalogReferenceAdminServiceError(400, 'imageUrl', 'https_required');
  }

  return imageUrl;
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

export async function listAdminCatalogCategories(
  db: CatalogDatabase,
  pagination: CatalogReferencePagination,
) {
  const items = await db
    .select()
    .from(catalogCategories)
    .orderBy(asc(catalogCategories.name), asc(catalogCategories.id))
    .limit(pagination.limit)
    .offset(pagination.offset);

  return { items, ...pagination };
}

export async function getAdminCatalogCategory(db: CatalogDatabase, id: string) {
  const [category] = await db
    .select()
    .from(catalogCategories)
    .where(eq(catalogCategories.id, id))
    .limit(1);

  if (!category) {
    throw new CatalogReferenceAdminServiceError(404, 'id', 'not_found');
  }

  return category;
}

export async function createAdminCatalogCategory(
  db: CatalogDatabase,
  input: CreateCatalogCategoryInput,
) {
  if (!catalogAttributeRuleSetKeys.includes(input.attributeRuleSetKey)) {
    throw new CatalogReferenceAdminServiceError(400, 'attributeRuleSetKey', 'unsupported');
  }

  try {
    const [category] = await db
      .insert(catalogCategories)
      .values({
        slug: validateSlug(input.slug),
        name: normalizeName(input.name),
        imageUrl: validateImageUrl(input.imageUrl) ?? null,
        attributeRuleSetKey: input.attributeRuleSetKey,
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      })
      .returning();

    return category;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CatalogReferenceAdminServiceError(409, 'slug', 'duplicate');
    }

    throw error;
  }
}

export async function updateAdminCatalogCategory(
  db: CatalogDatabase,
  id: string,
  input: UpdateCatalogCategoryInput,
) {
  const values: {
    name?: string;
    imageUrl?: string | null;
    isActive?: boolean;
    updatedAt: Date;
  } = { updatedAt: new Date() };

  if (input.name !== undefined) {
    values.name = normalizeName(input.name);
  }

  if (input.imageUrl !== undefined) {
    values.imageUrl = validateImageUrl(input.imageUrl) ?? null;
  }

  if (input.isActive !== undefined) {
    values.isActive = input.isActive;
  }

  const [category] = await db
    .update(catalogCategories)
    .set(values)
    .where(eq(catalogCategories.id, id))
    .returning();

  if (!category) {
    throw new CatalogReferenceAdminServiceError(404, 'id', 'not_found');
  }

  return category;
}

export async function listAdminCatalogBrands(
  db: CatalogDatabase,
  pagination: CatalogReferencePagination,
) {
  const items = await db
    .select()
    .from(catalogBrands)
    .orderBy(asc(catalogBrands.name), asc(catalogBrands.id))
    .limit(pagination.limit)
    .offset(pagination.offset);

  return { items, ...pagination };
}

export async function getAdminCatalogBrand(db: CatalogDatabase, id: string) {
  const [brand] = await db.select().from(catalogBrands).where(eq(catalogBrands.id, id)).limit(1);

  if (!brand) {
    throw new CatalogReferenceAdminServiceError(404, 'id', 'not_found');
  }

  return brand;
}

export async function createAdminCatalogBrand(db: CatalogDatabase, input: CreateCatalogBrandInput) {
  try {
    const [brand] = await db
      .insert(catalogBrands)
      .values({
        slug: validateSlug(input.slug),
        name: normalizeName(input.name),
        imageUrl: validateImageUrl(input.imageUrl) ?? null,
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      })
      .returning();

    return brand;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CatalogReferenceAdminServiceError(409, 'slug', 'duplicate');
    }

    throw error;
  }
}

export async function updateAdminCatalogBrand(
  db: CatalogDatabase,
  id: string,
  input: UpdateCatalogBrandInput,
) {
  const values: {
    name?: string;
    imageUrl?: string | null;
    isActive?: boolean;
    updatedAt: Date;
  } = { updatedAt: new Date() };

  if (input.name !== undefined) {
    values.name = normalizeName(input.name);
  }

  if (input.imageUrl !== undefined) {
    values.imageUrl = validateImageUrl(input.imageUrl) ?? null;
  }

  if (input.isActive !== undefined) {
    values.isActive = input.isActive;
  }

  const [brand] = await db
    .update(catalogBrands)
    .set(values)
    .where(eq(catalogBrands.id, id))
    .returning();

  if (!brand) {
    throw new CatalogReferenceAdminServiceError(404, 'id', 'not_found');
  }

  return brand;
}
