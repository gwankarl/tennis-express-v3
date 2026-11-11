import type { CatalogAttributeRuleSetKey } from './category-attribute-rule-sets.js';
import { catalogAttributeRulesByRuleSet, type CatalogAttributeRule } from './attribute-rules.js';

export interface CatalogVariantInput {
  optionValues: Record<string, unknown>;
}

export interface CatalogProductValidationInput {
  ruleSetKey: CatalogAttributeRuleSetKey;
  fixedAttributes?: Record<string, unknown>;
  variantOptionKeys?: readonly string[];
  variants?: readonly CatalogVariantInput[];
}

export interface ValidatedCatalogVariant {
  optionValues: Record<string, unknown>;
  optionSignature: string;
  isDefault: boolean;
}

export interface ValidatedCatalogProductAttributes {
  fixedAttributes: Record<string, unknown>;
  variantOptionKeys: string[];
  variants: ValidatedCatalogVariant[];
}

export class CatalogProductValidationError extends Error {
  constructor(
    readonly field: string,
    readonly rule: string,
  ) {
    super('Catalog product attributes are invalid.');
    this.name = 'CatalogProductValidationError';
  }
}

function fail(field: string, rule: string): never {
  throw new CatalogProductValidationError(field, rule);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeValue(rule: CatalogAttributeRule, value: unknown, field: string): unknown {
  if (rule.type === 'enum') {
    if (typeof value !== 'string') {
      return fail(field, 'invalid_type');
    }

    const normalized = value.trim();

    if (!rule.allowedValues?.includes(normalized)) {
      return fail(field, 'unsupported_value');
    }

    return normalized;
  }

  if (rule.type === 'number' || rule.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (rule.type === 'integer' && !Number.isInteger(value))
    ) {
      return fail(field, rule.type === 'integer' ? 'invalid_integer' : 'invalid_number');
    }

    if (rule.min !== undefined && value < rule.min) {
      return fail(field, 'below_minimum');
    }

    if (rule.max !== undefined && value > rule.max) {
      return fail(field, 'above_maximum');
    }

    if (rule.step !== undefined) {
      const steps = (value - (rule.min ?? 0)) / rule.step;

      if (Math.abs(steps - Math.round(steps)) > 1e-8) {
        return fail(field, 'invalid_step');
      }
    }

    if (rule.allowedValues && !rule.allowedValues.includes(value)) {
      return fail(field, 'unsupported_value');
    }

    return value;
  }

  if (rule.type === 'string') {
    if (typeof value !== 'string') {
      return fail(field, 'invalid_type');
    }

    const normalized = value.trim();

    if (!normalized) {
      return fail(field, 'required');
    }

    if (rule.maxLength !== undefined && normalized.length > rule.maxLength) {
      return fail(field, 'too_long');
    }

    if (rule.pattern && !new RegExp(rule.pattern, 'u').test(normalized)) {
      return fail(field, 'invalid_format');
    }

    return normalized;
  }

  if (rule.type === 'string_array') {
    if (!Array.isArray(value) || value.length === 0) {
      return fail(field, 'required');
    }

    if (rule.maxItems !== undefined && value.length > rule.maxItems) {
      return fail(field, 'too_many_items');
    }

    const normalized = value.map((item, index) => {
      if (typeof item !== 'string') {
        return fail(`${field}.${index}`, 'invalid_type');
      }

      const trimmed = item.trim();

      if (!trimmed) {
        return fail(`${field}.${index}`, 'required');
      }

      if (rule.maxLength !== undefined && trimmed.length > rule.maxLength) {
        return fail(`${field}.${index}`, 'too_long');
      }

      return trimmed;
    });

    const folded = normalized.map((item) => item.toLowerCase());

    if (new Set(folded).size !== folded.length) {
      return fail(field, 'duplicate_value');
    }

    return normalized;
  }

  if (!isRecord(value)) {
    return fail(field, 'invalid_type');
  }

  const dimensionKeys = ['height', 'length', 'width'];
  const suppliedKeys = Object.keys(value).sort();

  if (JSON.stringify(suppliedKeys) !== JSON.stringify(dimensionKeys)) {
    return fail(field, 'expected_length_width_height');
  }

  const dimensions: Record<string, number> = {};

  for (const key of dimensionKeys) {
    const dimension = value[key];

    if (typeof dimension !== 'number' || !Number.isFinite(dimension) || dimension <= 0) {
      return fail(`${field}.${key}`, 'must_be_positive_number');
    }

    dimensions[key] = dimension;
  }

  return dimensions;
}

function isRequired(rule: CatalogAttributeRule, attributes: Record<string, unknown>): boolean {
  if (rule.requiredWhen?.length) {
    return rule.requiredWhen.some(({ field, equals }) => attributes[field] === equals);
  }

  return rule.required;
}

/** Sorts option keys so caller key order does not affect variant identity. */
export function canonicalizeCatalogVariantOptions(optionValues: Record<string, unknown>): string {
  const sortedEntries = Object.entries(optionValues).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  return JSON.stringify(Object.fromEntries(sortedEntries));
}

/**
 * Validates fixed product details and all variant configurations as one unit.
 * With no selectable option keys, the result includes exactly one default variant.
 */
export function validateCatalogProductAttributes(
  input: CatalogProductValidationInput,
): ValidatedCatalogProductAttributes {
  const rules = catalogAttributeRulesByRuleSet[input.ruleSetKey] as readonly CatalogAttributeRule[];
  const rulesByKey = new Map(rules.map((rule) => [rule.key, rule]));
  const rawFixedAttributes = input.fixedAttributes ?? {};
  const rawOptionKeys = input.variantOptionKeys ?? [];
  const rawVariants = input.variants ?? [];

  if (!isRecord(rawFixedAttributes)) {
    return fail('fixedAttributes', 'expected_object');
  }

  if (!Array.isArray(rawOptionKeys) || rawOptionKeys.some((key) => typeof key !== 'string')) {
    return fail('variantOptionKeys', 'expected_string_array');
  }

  if (!Array.isArray(rawVariants)) {
    return fail('variants', 'expected_array');
  }

  const optionKeys = [...rawOptionKeys];

  if (new Set(optionKeys).size !== optionKeys.length) {
    return fail('variantOptionKeys', 'duplicate_option_key');
  }

  for (const key of optionKeys) {
    const rule = rulesByKey.get(key);

    if (!rule) {
      return fail('variantOptionKeys', 'unknown_option_key');
    }

    if (!rule.variantAllowed) {
      return fail(`variantOptionKeys.${key}`, 'field_cannot_vary');
    }
  }

  const normalizedFixedAttributes: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rawFixedAttributes)) {
    const field = `fixedAttributes.${key}`;
    const rule = rulesByKey.get(key);

    if (!rule) {
      return fail(field, 'unknown_field');
    }

    if (optionKeys.includes(key)) {
      return fail(field, 'conflicts_with_variant_option');
    }

    normalizedFixedAttributes[key] = normalizeValue(rule, value, field);
  }

  if (optionKeys.length === 0 && rawVariants.length > 0) {
    return fail('variants', 'variants_not_allowed_without_options');
  }

  if (optionKeys.length > 0 && rawVariants.length === 0) {
    return fail('variants', 'at_least_one_variant_required');
  }

  const variantInputs = optionKeys.length === 0 ? [{ optionValues: {} }] : rawVariants;

  const seenSignatures = new Set<string>();
  const normalizedVariants: ValidatedCatalogVariant[] = variantInputs.map((variant, index) => {
    const variantField = `variants.${index}.optionValues`;

    if (!isRecord(variant) || !isRecord(variant.optionValues)) {
      return fail(variantField, 'expected_object');
    }

    const suppliedOptionKeys = Object.keys(variant.optionValues);

    for (const key of suppliedOptionKeys) {
      if (!optionKeys.includes(key)) {
        return fail(`${variantField}.${key}`, 'not_a_selected_variant_option');
      }
    }

    const normalizedOptionValues: Record<string, unknown> = {};

    for (const key of optionKeys) {
      if (!Object.hasOwn(variant.optionValues, key)) {
        return fail(`${variantField}.${key}`, 'required');
      }

      const rule = rulesByKey.get(key);

      if (!rule) {
        return fail(`${variantField}.${key}`, 'unknown_option_key');
      }

      normalizedOptionValues[key] = normalizeValue(
        rule,
        variant.optionValues[key],
        `${variantField}.${key}`,
      );
    }

    const effectiveAttributes = {
      ...normalizedFixedAttributes,
      ...normalizedOptionValues,
    };

    for (const rule of rules) {
      if (isRequired(rule, effectiveAttributes) && !Object.hasOwn(effectiveAttributes, rule.key)) {
        return fail(`attributes.${rule.key}`, 'required');
      }
    }

    const optionSignature = canonicalizeCatalogVariantOptions(normalizedOptionValues);

    if (seenSignatures.has(optionSignature)) {
      return fail('variants', 'duplicate_variant_combination');
    }

    seenSignatures.add(optionSignature);

    return {
      optionValues: normalizedOptionValues,
      optionSignature,
      isDefault: optionKeys.length === 0,
    };
  });

  return {
    fixedAttributes: normalizedFixedAttributes,
    variantOptionKeys: [...optionKeys].sort(),
    variants: normalizedVariants,
  };
}
