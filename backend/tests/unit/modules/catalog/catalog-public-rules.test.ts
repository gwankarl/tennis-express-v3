import { describe, expect, it } from 'vitest';
import { catalogAttributeRuleSetKeys } from '../../../../src/modules/catalog/category-attribute-rule-sets.js';
import { getPublicCatalogAttributeRules } from '../../../../src/modules/catalog/catalog-public-rules.js';
import {
  CatalogProductValidationError,
  validateCatalogProductAttributes,
} from '../../../../src/modules/catalog/product-validation.js';

describe('public catalog attribute rules', () => {
  it('projects the supported rule sets and display fields', () => {
    expect(catalogAttributeRuleSetKeys).toHaveLength(7);

    for (const ruleSetKey of catalogAttributeRuleSetKeys) {
      const rules = getPublicCatalogAttributeRules(ruleSetKey);

      expect(rules.length).toBeGreaterThan(0);
      expect(new Set(rules.map((rule) => rule.key)).size).toBe(rules.length);

      for (const rule of rules) {
        expect(rule.key).toEqual(expect.any(String));
        expect(rule.label).toEqual(expect.any(String));
        expect(rule.type).toEqual(expect.any(String));
        expect(rule.required).toEqual(expect.any(Boolean));
        expect(rule.variantAllowed).toEqual(expect.any(Boolean));
        expect(Array.isArray(rule.requiredWhen)).toBe(true);
      }
    }
  });

  it('distinguishes category variation capability from product variant selection', () => {
    const rules = getPublicCatalogAttributeRules('tennis_shoes');
    const euSize = rules.find((rule) => rule.key === 'euSize');

    expect(euSize).toMatchObject({
      key: 'euSize',
      unit: 'EU',
      variantAllowed: true,
      required: true,
    });

    const product = validateCatalogProductAttributes({
      ruleSetKey: 'tennis_shoes',
      fixedAttributes: { courtSurface: 'hard_court', euSize: 42 },
    });

    expect(product.variantOptionKeys).toEqual([]);
    expect(product.variants).toHaveLength(1);
    expect(product.variants[0]).toMatchObject({ optionValues: {}, isDefault: true });
  });

  it('projects accessory compatibility as one field with all conditional requirements', () => {
    const rules = getPublicCatalogAttributeRules('racquet_accessories');
    const compatibilityRules = rules.filter((rule) => rule.key === 'compatibleRacquetModels');

    expect(compatibilityRules).toHaveLength(1);
    expect(compatibilityRules[0]?.requiredWhen).toEqual([
      { field: 'accessoryType', equals: 'grommet_set' },
      { field: 'accessoryType', equals: 'bumper_guard' },
      { field: 'accessoryType', equals: 'model_specific_other' },
    ]);
  });

  it.each(['grommet_set', 'bumper_guard', 'model_specific_other'])(
    'requires compatible racquet models for %s',
    (accessoryType) => {
      expect(() =>
        validateCatalogProductAttributes({
          ruleSetKey: 'racquet_accessories',
          fixedAttributes: { accessoryType, piecesPerPack: 1 },
        }),
      ).toThrow(CatalogProductValidationError);

      expect(
        validateCatalogProductAttributes({
          ruleSetKey: 'racquet_accessories',
          fixedAttributes: {
            accessoryType,
            piecesPerPack: 1,
            compatibleRacquetModels: ['Synthetic model'],
          },
        }).fixedAttributes.compatibleRacquetModels,
      ).toEqual(['Synthetic model']);
    },
  );

  it('does not require compatible racquet models for general accessories', () => {
    expect(
      validateCatalogProductAttributes({
        ruleSetKey: 'racquet_accessories',
        fixedAttributes: { accessoryType: 'dampener', piecesPerPack: 1 },
      }).fixedAttributes,
    ).toEqual({ accessoryType: 'dampener', piecesPerPack: 1 });
  });
});
