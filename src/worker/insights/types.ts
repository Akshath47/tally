// What an insight is (docs/phase-2-insights-spec.md, Insights). Kept apart from ./rules.ts and
// import-free, so the web app can use it and ./wording.ts without pulling in D1 code.

export type Insight =
  | { id: string; type: "stale_account"; severity: "warn"; accountId: number; staleDays: number }
  | {
      id: string;
      type: "pace";
      severity: "over" | "warn";
      state: "over" | "projected_over";
      /** null = the whole budget. */
      categoryId: number | null;
      spentMinor: number;
      allocatedMinor: number;
      projectedMinor: number;
    }
  | { id: string; type: "unusual_category"; severity: "warn"; categoryId: number | null; spentMinor: number; baselineMinor: number }
  | {
      id: string;
      type: "large_charge";
      severity: "info";
      transactionId: number;
      merchantKey: string;
      name: string;
      spentMinor: number;
      /** null = a new merchant. */
      merchantAverageMinor: number | null;
      countedDate: string;
      isPending: boolean;
    }
  | { id: string; type: "month_change"; severity: "info"; categoryId: number | null; month: string; spentMinor: number; previousSpentMinor: number; changeMinor: number };
