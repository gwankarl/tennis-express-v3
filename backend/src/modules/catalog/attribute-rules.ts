import type { CatalogAttributeRuleSetKey } from './category-attribute-rule-sets.js';

export type CatalogAttributeRuleType =
  'enum' | 'number' | 'integer' | 'string' | 'string_array' | 'dimensions';

export interface CatalogAttributeRule {
  key: string;
  label: string;
  type: CatalogAttributeRuleType;
  required: boolean;
  allowedValues?: readonly (string | number)[];
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  maxItems?: number;
  pattern?: string;
  variantAllowed?: boolean;
  requiredWhen?: {
    field: string;
    equals: string | number;
  };
}

const colorValues = [
  'black',
  'white',
  'red',
  'blue',
  'green',
  'yellow',
  'orange',
  'pink',
  'purple',
  'gray',
  'brown',
  'multicolor',
  'other',
] as const;

const ballSurfaceValues = ['hard_court', 'clay_court', 'grass_court', 'all_court'] as const;
const shoeSurfaceValues = ['hard_court', 'clay_court', 'all_court'] as const;

const stringThicknessValues = [1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4] as const;

const ruleSets = {
  tennis_racquets: [
    {
      key: 'audience',
      label: 'Adult or junior',
      type: 'enum',
      required: true,
      allowedValues: ['adult', 'junior'],
    },
    {
      key: 'lengthInches',
      label: 'Length',
      type: 'number',
      required: true,
      unit: 'in',
      min: 1,
    },
    {
      key: 'gripSize',
      label: 'Grip size',
      type: 'enum',
      required: false,
      allowedValues: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'],
      variantAllowed: true,
      requiredWhen: { field: 'audience', equals: 'adult' },
    },
    {
      key: 'headSizeSquareInches',
      label: 'Head size',
      type: 'number',
      required: false,
      unit: 'in²',
      min: 1,
    },
    {
      key: 'unstrungWeightGrams',
      label: 'Unstrung weight',
      type: 'number',
      required: false,
      unit: 'g',
      min: 1,
    },
    {
      key: 'stringPattern',
      label: 'String pattern',
      type: 'string',
      required: false,
      maxLength: 16,
      pattern: '^[0-9]{1,2}x[0-9]{1,2}$',
    },
  ],
  tennis_balls: [
    {
      key: 'typeOrStage',
      label: 'Type or stage',
      type: 'enum',
      required: true,
      allowedValues: ['standard', 'red', 'orange', 'green'],
    },
    {
      key: 'pressurization',
      label: 'Pressurization',
      type: 'enum',
      required: true,
      allowedValues: ['pressurized', 'pressureless'],
    },
    {
      key: 'ballsPerPack',
      label: 'Balls per pack',
      type: 'integer',
      required: true,
      min: 1,
      max: 100,
      variantAllowed: true,
    },
    {
      key: 'intendedCourtSurface',
      label: 'Intended court surface',
      type: 'enum',
      required: false,
      allowedValues: ballSurfaceValues,
    },
  ],
  racquet_strings: [
    {
      key: 'material',
      label: 'Material',
      type: 'enum',
      required: true,
      allowedValues: ['natural_gut', 'multifilament', 'nylon', 'polyester', 'hybrid', 'other'],
    },
    {
      key: 'thicknessMm',
      label: 'Thickness',
      type: 'number',
      required: true,
      unit: 'mm',
      allowedValues: stringThicknessValues,
      variantAllowed: true,
    },
    {
      key: 'format',
      label: 'Set or reel',
      type: 'enum',
      required: true,
      allowedValues: ['set', 'reel'],
    },
    {
      key: 'lengthMetres',
      label: 'Length',
      type: 'number',
      required: true,
      unit: 'm',
      min: 1,
    },
    {
      key: 'color',
      label: 'Color',
      type: 'enum',
      required: false,
      allowedValues: colorValues,
    },
  ],
  grips_overgrips: [
    {
      key: 'gripType',
      label: 'Grip type',
      type: 'enum',
      required: true,
      allowedValues: ['replacement_grip', 'overgrip'],
    },
    {
      key: 'piecesPerPack',
      label: 'Pieces per pack',
      type: 'integer',
      required: true,
      min: 1,
      max: 100,
      variantAllowed: true,
    },
    {
      key: 'color',
      label: 'Color',
      type: 'enum',
      required: false,
      allowedValues: colorValues,
      variantAllowed: true,
    },
    {
      key: 'thicknessMm',
      label: 'Thickness',
      type: 'number',
      required: false,
      unit: 'mm',
      min: 0.5,
      max: 5,
    },
  ],
  tennis_shoes: [
    {
      key: 'euSize',
      label: 'Manufacturer EU size',
      type: 'number',
      required: true,
      unit: 'EU',
      min: 30,
      max: 50,
      step: 0.5,
      variantAllowed: true,
    },
    {
      key: 'courtSurface',
      label: 'Intended court surface',
      type: 'enum',
      required: true,
      allowedValues: shoeSurfaceValues,
    },
    {
      key: 'width',
      label: 'Width',
      type: 'enum',
      required: false,
      allowedValues: ['narrow', 'regular', 'wide', 'extra_wide'],
    },
    {
      key: 'color',
      label: 'Color',
      type: 'enum',
      required: false,
      allowedValues: colorValues,
      variantAllowed: true,
    },
  ],
  tennis_bags: [
    {
      key: 'bagType',
      label: 'Bag type',
      type: 'enum',
      required: true,
      allowedValues: ['backpack', 'thermobag', 'duffel', 'tote', 'other'],
    },
    {
      key: 'racquetCapacity',
      label: 'Racquet capacity',
      type: 'integer',
      required: true,
      min: 0,
      max: 15,
      variantAllowed: true,
    },
    {
      key: 'color',
      label: 'Color',
      type: 'enum',
      required: false,
      allowedValues: colorValues,
      variantAllowed: true,
    },
    {
      key: 'dimensionsCm',
      label: 'Dimensions',
      type: 'dimensions',
      required: false,
      unit: 'cm',
    },
  ],
  racquet_accessories: [
    {
      key: 'accessoryType',
      label: 'Accessory type',
      type: 'enum',
      required: true,
      allowedValues: [
        'dampener',
        'grommet_set',
        'bumper_guard',
        'racket_tape',
        'other',
        'model_specific_other',
      ],
    },
    {
      key: 'piecesPerPack',
      label: 'Pieces per pack',
      type: 'integer',
      required: true,
      min: 1,
      max: 100,
      variantAllowed: true,
    },
    {
      key: 'color',
      label: 'Color',
      type: 'enum',
      required: false,
      allowedValues: colorValues,
      variantAllowed: true,
    },
    {
      key: 'compatibleRacquetModels',
      label: 'Compatible racquet models',
      type: 'string_array',
      required: false,
      maxItems: 50,
      maxLength: 120,
      requiredWhen: { field: 'accessoryType', equals: 'grommet_set' },
    },
    {
      key: 'compatibleRacquetModels',
      label: 'Compatible racquet models',
      type: 'string_array',
      required: false,
      maxItems: 50,
      maxLength: 120,
      requiredWhen: { field: 'accessoryType', equals: 'bumper_guard' },
    },
    {
      key: 'compatibleRacquetModels',
      label: 'Compatible racquet models',
      type: 'string_array',
      required: false,
      maxItems: 50,
      maxLength: 120,
      requiredWhen: { field: 'accessoryType', equals: 'model_specific_other' },
    },
  ],
} as const satisfies Record<CatalogAttributeRuleSetKey, readonly CatalogAttributeRule[]>;

export const catalogAttributeRulesByRuleSet: Record<
  CatalogAttributeRuleSetKey,
  readonly CatalogAttributeRule[]
> = ruleSets;
