export const catalogAttributeRuleSetKeys = [
  'tennis_racquets',
  'tennis_balls',
  'racquet_strings',
  'grips_overgrips',
  'tennis_shoes',
  'tennis_bags',
  'racquet_accessories',
] as const;

export type CatalogAttributeRuleSetKey = (typeof catalogAttributeRuleSetKeys)[number];
