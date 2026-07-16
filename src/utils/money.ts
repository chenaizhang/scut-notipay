/**
 * Normalize a monetary amount to cents and collapse JavaScript's negative zero.
 */
export const normalizeCurrency = (value: number): number => {
  if (!Number.isFinite(value)) return value;
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
};
