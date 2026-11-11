import { describe, expect, it } from 'vitest';
import { catalogAttributeRulesByRuleSet } from '../../../../src/modules/catalog/attribute-rules.js';
import type { CatalogAttributeRuleSetKey } from '../../../../src/modules/catalog/category-attribute-rule-sets.js';
import {
  CatalogProductValidationError,
  canonicalizeCatalogVariantOptions,
  validateCatalogProductAttributes,
  type CatalogProductValidationInput,
} from '../../../../src/modules/catalog/product-validation.js';

const validCategoryExamples: Array<{
  name: string;
  input: CatalogProductValidationInput;
}> = [
  {
    name: 'Tennis racquets',
    input: {
      ruleSetKey: 'tennis_racquets',
      fixedAttributes: {
        audience: 'adult',
        lengthInches: 27,
        gripSize: 'L2',
      },
    },
  },
  {
    name: 'Tennis balls',
    input: {
      ruleSetKey: 'tennis_balls',
      fixedAttributes: {
        typeOrStage: 'standard',
        pressurization: 'pressurized',
        ballsPerPack: 3,
      },
    },
  },
  {
    name: 'Racquet strings',
    input: {
      ruleSetKey: 'racquet_strings',
      fixedAttributes: {
        material: 'polyester',
        thicknessMm: 1.25,
        format: 'set',
        lengthMetres: 12,
      },
    },
  },
  {
    name: 'Grips and overgrips',
    input: {
      ruleSetKey: 'grips_overgrips',
      fixedAttributes: {
        gripType: 'overgrip',
        piecesPerPack: 3,
      },
    },
  },
  {
    name: 'Tennis shoes',
    input: {
      ruleSetKey: 'tennis_shoes',
      fixedAttributes: {
        euSize: 42,
        courtSurface: 'hard_court',
      },
    },
  },
  {
    name: 'Tennis bags',
    input: {
      ruleSetKey: 'tennis_bags',
      fixedAttributes: {
        bagType: 'backpack',
        racquetCapacity: 2,
      },
    },
  },
  {
    name: 'Racquet accessories',
    input: {
      ruleSetKey: 'racquet_accessories',
      fixedAttributes: {
        accessoryType: 'dampener',
        piecesPerPack: 1,
      },
    },
  },
];

function expectValidationError(callback: () => unknown, field: string, rule: string): void {
  try {
    callback();
    throw new Error('Expected catalog validation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogProductValidationError);
    expect(error).toMatchObject({ field, rule });
  }
}

describe('catalog attribute rules', () => {
  it.each(validCategoryExamples)('accepts the required $name details', ({ input }) => {
    const result = validateCatalogProductAttributes(input);

    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]).toMatchObject({
      optionValues: {},
      optionSignature: '{}',
      isDefault: true,
    });
  });

  it('defines exactly the seven supported category rule-set keys', () => {
    expect(Object.keys(catalogAttributeRulesByRuleSet).sort()).toEqual([
      'grips_overgrips',
      'racquet_accessories',
      'racquet_strings',
      'tennis_bags',
      'tennis_balls',
      'tennis_racquets',
      'tennis_shoes',
    ] satisfies CatalogAttributeRuleSetKey[]);
  });
});

describe('catalog product and variant validation', () => {
  it('allows adult grip size to be fixed or supplied by variants', () => {
    const fixed = validateCatalogProductAttributes({
      ruleSetKey: 'tennis_racquets',
      fixedAttributes: {
        audience: 'adult',
        lengthInches: 27,
        gripSize: 'L2',
      },
    });

    const varied = validateCatalogProductAttributes({
      ruleSetKey: 'tennis_racquets',
      fixedAttributes: {
        audience: 'adult',
        lengthInches: 27,
      },
      variantOptionKeys: ['gripSize'],
      variants: [{ optionValues: { gripSize: 'L2' } }, { optionValues: { gripSize: 'L3' } }],
    });

    expect(fixed.fixedAttributes.gripSize).toBe('L2');
    expect(varied.variants.map((variant) => variant.optionValues.gripSize)).toEqual(['L2', 'L3']);
    expect(varied.variants.every((variant) => !variant.isDefault)).toBe(true);
  });

  it('does not require grip size for a junior racquet', () => {
    const result = validateCatalogProductAttributes({
      ruleSetKey: 'tennis_racquets',
      fixedAttributes: {
        audience: 'junior',
        lengthInches: 25,
      },
    });

    expect(result.fixedAttributes.gripSize).toBeUndefined();
  });

  it('rejects adult racquets without grip size in the fixed details or each variant', () => {
    expectValidationError(
      () =>
        validateCatalogProductAttributes({
          ruleSetKey: 'tennis_racquets',
          fixedAttributes: {
            audience: 'adult',
            lengthInches: 27,
          },
        }),
      'attributes.gripSize',
      'required',
    );

    expectValidationError(
      () =>
        validateCatalogProductAttributes({
          ruleSetKey: 'tennis_racquets',
          fixedAttributes: {
            audience: 'adult',
            lengthInches: 27,
          },
          variantOptionKeys: ['gripSize'],
          variants: [{ optionValues: {} }],
        }),
      'variants.0.optionValues.gripSize',
      'required',
    );
  });

  it('rejects fixed and variant-option values for the same field', () => {
    expectValidationError(
      () =>
        validateCatalogProductAttributes({
          ruleSetKey: 'grips_overgrips',
          fixedAttributes: {
            gripType: 'overgrip',
            piecesPerPack: 3,
            color: 'black',
          },
          variantOptionKeys: ['color'],
          variants: [{ optionValues: { color: 'red' } }],
        }),
      'fixedAttributes.color',
      'conflicts_with_variant_option',
    );
  });

  it('requires every selected variant option in every configuration', () => {
    expectValidationError(
      () =>
        validateCatalogProductAttributes({
          ruleSetKey: 'grips_overgrips',
          fixedAttributes: { gripType: 'overgrip' },
          variantOptionKeys: ['color', 'piecesPerPack'],
          variants: [{ optionValues: { color: 'black' } }],
        }),
      'variants.0.optionValues.piecesPerPack',
      'required',
    );
  });

  it('rejects duplicate combinations even when option keys arrive in a different order', () => {
    expectValidationError(
      () =>
        validateCatalogProductAttributes({
          ruleSetKey: 'grips_overgrips',
          fixedAttributes: { gripType: 'overgrip' },
          variantOptionKeys: ['color', 'piecesPerPack'],
          variants: [
            { optionValues: { color: 'black', piecesPerPack: 3 } },
            { optionValues: { piecesPerPack: 3, color: 'black' } },
          ],
        }),
      'variants',
      'duplicate_variant_combination',
    );

    expect(canonicalizeCatalogVariantOptions({ color: 'black', piecesPerPack: 3 })).toBe(
      canonicalizeCatalogVariantOptions({ piecesPerPack: 3, color: 'black' }),
    );
  });

  it('rejects a variant option that the category does not permit', () => {
    expectValidationError(
      () =>
        validateCatalogProductAttributes({
          ruleSetKey: 'tennis_bags',
          fixedAttributes: { bagType: 'backpack' },
          variantOptionKeys: ['bagType'],
          variants: [{ optionValues: { bagType: 'backpack' } }],
        }),
      'variantOptionKeys.bagType',
      'field_cannot_vary',
    );
  });

  it('validates enumerated values, units, and numeric increments', () => {
    expectValidationError(
      () =>
        validateCatalogProductAttributes({
          ruleSetKey: 'tennis_balls',
          fixedAttributes: {
            typeOrStage: 'purple',
            pressurization: 'pressurized',
            ballsPerPack: 3,
          },
        }),
      'fixedAttributes.typeOrStage',
      'unsupported_value',
    );

    expectValidationError(
      () =>
        validateCatalogProductAttributes({
          ruleSetKey: 'tennis_shoes',
          fixedAttributes: { euSize: 42.2, courtSurface: 'hard_court' },
        }),
      'fixedAttributes.euSize',
      'invalid_step',
    );

    expectValidationError(
      () =>
        validateCatalogProductAttributes({
          ruleSetKey: 'racquet_strings',
          fixedAttributes: {
            material: 'polyester',
            thicknessMm: 1.22,
            format: 'reel',
            lengthMetres: 200,
          },
        }),
      'fixedAttributes.thicknessMm',
      'unsupported_value',
    );
  });

  it('requires compatible racquet models for model-specific accessories', () => {
    expectValidationError(
      () =>
        validateCatalogProductAttributes({
          ruleSetKey: 'racquet_accessories',
          fixedAttributes: {
            accessoryType: 'grommet_set',
            piecesPerPack: 1,
          },
        }),
      'attributes.compatibleRacquetModels',
      'required',
    );

    const result = validateCatalogProductAttributes({
      ruleSetKey: 'racquet_accessories',
      fixedAttributes: {
        accessoryType: 'grommet_set',
        piecesPerPack: 1,
        compatibleRacquetModels: ['Synthetic Model A'],
      },
    });

    expect(result.fixedAttributes.compatibleRacquetModels).toEqual(['Synthetic Model A']);
  });

  it('rejects unknown product details and unexpected values inside dimensions', () => {
    expectValidationError(
      () =>
        validateCatalogProductAttributes({
          ruleSetKey: 'tennis_bags',
          fixedAttributes: {
            bagType: 'backpack',
            racquetCapacity: 2,
            unknownDetail: 'not allowed',
          },
        }),
      'fixedAttributes.unknownDetail',
      'unknown_field',
    );

    expectValidationError(
      () =>
        validateCatalogProductAttributes({
          ruleSetKey: 'tennis_bags',
          fixedAttributes: {
            bagType: 'backpack',
            racquetCapacity: 2,
            dimensionsCm: { length: 70, width: 30, height: 25, depth: 20 },
          },
        }),
      'fixedAttributes.dimensionsCm',
      'expected_length_width_height',
    );
  });
});
