// Integer arithmetic for figures derived from minor units (docs/phase-2-insights-spec.md):
// divisions floor, nothing goes through a float.

/** a ÷ b rounded down (towards −∞), for safe integers and b > 0. */
export function floorDiv(a: number, b: number): number {
  const q = BigInt(a) / BigInt(b);
  return Number(BigInt(a) % BigInt(b) < 0n ? q - 1n : q);
}

/** Spend by the month's end at this rate: floor(spent × days in month ÷ day of month). */
export const projectedMinor = (spentMinor: number, dom: number, dim: number) => floorDiv(spentMinor * dim, dom);
