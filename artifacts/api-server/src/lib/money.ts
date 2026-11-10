const MONEY_PATTERN = /^[0-9]+(?:\.[0-9]{1,6})?$/;

/**
 * Validates positive decimal strings without converting money to a JS float.
 * Storage and all later arithmetic use PostgreSQL numeric values.
 */
export function isPositiveMoney(value: string): boolean {
  if (value.length > 25) return false;
  if (!MONEY_PATTERN.test(value)) return false;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) > 0n || /[1-9]/.test(fraction);
}
