import type { CatalogAttributeRule } from './attribute-rules.js';
import { catalogAttributeRulesByRuleSet } from './attribute-rules.js';
import type { CatalogAttributeRuleSetKey } from './category-attribute-rule-sets.js';

export interface PublicCatalogAttributeRule {
  key: string;
  label: string;
  type: CatalogAttributeRule['type'];
  required: boolean;
  variantAllowed: boolean;
  allowedValues?: readonly (string | number)[];
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  maxItems?: number;
  pattern?: string;
  requiredWhen: readonly {
    field: string;
    equals: string | number;
  }[];
}

/** Returns the code-defined validation and display rules for a public category. */
export function getPublicCatalogAttributeRules(
  ruleSetKey: CatalogAttributeRuleSetKey,
): PublicCatalogAttributeRule[] {
  return catalogAttributeRulesByRuleSet[ruleSetKey].map((rule) => ({
    key: rule.key,
    label: rule.label,
    type: rule.type,
    required: rule.required,
    variantAllowed: rule.variantAllowed ?? false,
    ...(rule.allowedValues ? { allowedValues: [...rule.allowedValues] } : {}),
    ...(rule.unit === undefined ? {} : { unit: rule.unit }),
    ...(rule.min === undefined ? {} : { min: rule.min }),
    ...(rule.max === undefined ? {} : { max: rule.max }),
    ...(rule.step === undefined ? {} : { step: rule.step }),
    ...(rule.maxLength === undefined ? {} : { maxLength: rule.maxLength }),
    ...(rule.maxItems === undefined ? {} : { maxItems: rule.maxItems }),
    ...(rule.pattern === undefined ? {} : { pattern: rule.pattern }),
    requiredWhen: (rule.requiredWhen ?? []).map(({ field, equals }) => ({
      field,
      equals,
    })),
  }));
}
